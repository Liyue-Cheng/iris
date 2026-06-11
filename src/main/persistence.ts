/**
 * @file src/main/persistence.ts
 * @purpose JSON file persistence: atomic write, corruption recovery,
 *   debounced writes. Ported from Marina (src/main/persistence.ts) — the
 *   only change is the logger import and dropping Marina's userData notes;
 *   Iris stores its app data under ~/.iris/ (see settings-manager).
 *
 * Key design:
 * - Atomic write: tmp file → fsync → rename; failure never corrupts the target
 * - Backup: existing target is copied to .bak before each successful write
 * - Load order: main file → .bak → caller-provided default (never writes the
 *   default back — a corrupted file is left for a human to inspect)
 * - 500ms debounce merges high-frequency updates
 *
 * Not done here:
 * - No schema validation (that's each manager's job; this is JSON I/O only)
 * - No file locking (Electron single-instance lock guarantees one writer)
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from './logger';

/**
 * Storage abstraction for a single JSON file. One JsonStore instance per
 * persisted schema. T is the in-memory shape; callers validate it.
 */
export class JsonStore<T> {
  private writeTimer: NodeJS.Timeout | null = null;
  private pendingValue: T | null = null;
  private lastValueInMemory: T | null = null;
  private writeInFlight: Promise<void> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly debounceMs: number = 500,
  ) {}

  /**
   * Load the file. Lookup order: main file → .bak → defaultValue.
   * All-fail returns defaultValue WITHOUT writing it to disk.
   */
  async load(defaultValue: T): Promise<{ value: T; source: 'main' | 'bak' | 'default' }> {
    const mainResult = await this.tryRead(this.filePath);
    if (mainResult !== null) {
      this.lastValueInMemory = mainResult as T;
      return { value: mainResult as T, source: 'main' };
    }

    const bakResult = await this.tryRead(this.bakPath());
    if (bakResult !== null) {
      this.lastValueInMemory = bakResult as T;
      return { value: bakResult as T, source: 'bak' };
    }

    this.lastValueInMemory = defaultValue;
    return { value: defaultValue, source: 'default' };
  }

  /** Current in-memory copy (last load/set). Null before load. */
  getInMemory(): T | null {
    return this.lastValueInMemory;
  }

  /**
   * Mark a new value to be persisted after debounceMs. Multiple calls merge;
   * the last value wins. Fire-and-forget: disk errors are logged, not thrown.
   * Await flush() if you need durability.
   */
  set(value: T): void {
    this.pendingValue = value;
    this.lastValueInMemory = value;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flushInternal().catch((err) => {
        logger.error('JsonStore', `flush failed for ${this.filePath}`, err);
      });
    }, this.debounceMs);
  }

  /** Persist any pending value now and wait for completion. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.flushInternal();
  }

  /** Clear timers. Does not write — flush first if data must land. */
  destroy(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.pendingValue = null;
  }

  // ──────────────────────────────────────────────────────────────────
  // Internal I/O
  // ──────────────────────────────────────────────────────────────────

  /**
   * Serialized writer: only one flushInternal runs at a time; set() during a
   * flush updates pendingValue and the while-loop writes it next.
   * (while instead of tail recursion: high-frequency set() faster than disk
   * writes must not grow the call stack — Marina CON-1.)
   */
  private async flushInternal(): Promise<void> {
    if (this.writeInFlight) {
      await this.writeInFlight.catch(() => {});
    }
    while (this.pendingValue !== null) {
      const valueToWrite = this.pendingValue;
      this.pendingValue = null;
      this.writeInFlight = this.atomicWrite(valueToWrite);
      try {
        await this.writeInFlight;
      } finally {
        this.writeInFlight = null;
      }
    }
  }

  private async atomicWrite(value: T): Promise<void> {
    const dir = dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    const json = JSON.stringify(value, null, 2);
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;

    // 1) write tmp file + fsync
    const fh = await fs.open(tmpPath, 'w');
    try {
      await fh.writeFile(json, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }

    // 2) copy existing target to .bak (ENOENT on first write is fine)
    try {
      await fs.copyFile(this.filePath, this.bakPath());
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('JsonStore', `backup copy failed for ${this.filePath}`, err);
      }
    }

    // 3) rename tmp → target (rename overwrites on Windows since Node 18)
    try {
      await fs.rename(tmpPath, this.filePath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      throw new Error(
        `[JsonStore] atomic rename failed: ${tmpPath} -> ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Read + JSON.parse. Missing file / parse failure / I/O error → null. */
  private async tryRead(path: string): Promise<unknown | null> {
    try {
      const text = await fs.readFile(path, 'utf8');
      return JSON.parse(text);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      logger.warn(
        'JsonStore',
        `read failed for ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private bakPath(): string {
    return `${this.filePath}.bak`;
  }
}

/** Create a temp data dir for tests. Tests must NEVER touch the real ~/.iris/. */
export async function createTempDataDir(prefix = 'iris-test-'): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

/** Remove a test temp dir, tolerating transient Windows EBUSY. */
export async function removeTempDataDir(path: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === 2) throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}
