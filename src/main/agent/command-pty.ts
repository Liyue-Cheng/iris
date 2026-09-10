import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { spawn, type IDisposable, type IPty } from 'node-pty';
import type { AgentCommandShell } from '@shared/agent-protocol';
import { applyNonInteractiveEnv, buildSpawnEnv } from '../pty-utils';
import { TerminalMirror } from '../terminal/terminal-mirror';
import { TerminalFlowController } from '../terminal/flow-controller';
import type { ProcessTreeKillFn } from '../terminal/process-tree';

export interface AgentCommandPtyResult {
  terminalId: string;
  exitCode: number;
  signal?: number;
  outputPath: string;
  outputBytes: number;
  finalCursor: number;
  shown: boolean;
  plainText: string;
  outputTruncated: boolean;
  /** Why the PTY was closed, when it was closed by the host. */
  termination?: 'natural' | 'timeout' | 'aborted';
}

export interface AgentCommandPtyEvent {
  type: 'output' | 'shown' | 'completed';
  terminalId: string;
  /** Byte offset of the first byte in `bytes` within the process output. */
  cursor?: number;
  /**
   * Raw PTY bytes. The owner batches them for an attached terminal dialog and
   * encodes once per IPC window, so this stays a Buffer instead of base64.
   */
  bytes?: Buffer;
  result?: AgentCommandPtyResult;
}

export interface AgentCommandOutputStore {
  append(path: string, bytes: Buffer): Promise<void>;
}

export interface AgentCommandPtyOptions {
  terminalId: string;
  command: string;
  cwd: string;
  outputPath: string;
  env?: NodeJS.ProcessEnv;
  commandShell?: AgentCommandShell;
  displayThresholdMs?: number;
  /** Hard foreground deadline in milliseconds. Omit only for legacy callers. */
  timeoutMs?: number;
  /**
   * Enable mirror backpressure. Omit when nothing consumes the mirror (a
   * background task only reads its plain-text tail): an unconsumed mirror must
   * never be able to pause the producer.
   */
  mirrorBackpressure?: boolean;
  spawnFn?: typeof spawn;
  outputStore?: AgentCommandOutputStore;
  /** Optional platform-specific descendant cleanup, used before closing the PTY. */
  processTreeKillFn?: ProcessTreeKillFn | null;
  onEvent?: (event: AgentCommandPtyEvent) => void;
}

/** Protocol limit for foreground terminal calls. Background tasks have no deadline. */
export const AGENT_TERMINAL_MAX_TIMEOUT_SECONDS = 3_600;

/**
 * Output backpressure budget, shared by the renderer delivery queue and the
 * headless mirror. Bytes in flight above the high watermark pause the PTY; it
 * resumes once both consumers are back under the low watermark.
 */
export const AGENT_TERMINAL_HIGH_WATER_BYTES = 384 * 1024;
export const AGENT_TERMINAL_LOW_WATER_BYTES = 96 * 1024;

export class AgentCommandPty {
  private readonly pty: IPty;
  private readonly disposables: IDisposable[] = [];
  private readonly displayTimer: ReturnType<typeof setTimeout>;
  private readonly timeoutTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Backpressure for the child process. Two sources feed it: the headless
   * mirror (main-side parse lag) and the owner's output batcher (an attached
   * terminal dialog that has not acknowledged yet). A paused PTY is released
   * only when both are clear.
   */
  private readonly flow = new TerminalFlowController(
    () => this.applyPtyPause(true),
    () => this.applyPtyPause(false),
  );
  private readonly mirror: TerminalMirror;
  private readonly outputDecoder = new StringDecoder('utf8');
  private outputChain = Promise.resolve();
  private cursor = 0;
  private outputLineCount = 1;
  private shown = false;
  private settled = false;
  private aborting = false;
  private termination: 'natural' | 'timeout' | 'aborted' = 'natural';
  private cleanupPromise: Promise<void> = Promise.resolve();
  private resolveResult!: (result: AgentCommandPtyResult) => void;
  private rejectResult!: (error: Error) => void;
  readonly result: Promise<AgentCommandPtyResult>;

  get pid(): number | undefined {
    return this.pty.pid || undefined;
  }

  constructor(private readonly options: AgentCommandPtyOptions) {
    if (options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 ||
        options.timeoutMs > AGENT_TERMINAL_MAX_TIMEOUT_SECONDS * 1000)) {
      throw new Error(`Terminal timeout must be a finite positive value no greater than ${AGENT_TERMINAL_MAX_TIMEOUT_SECONDS} seconds.`);
    }
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    const env = buildSpawnEnv(options.env ?? process.env, [
      'ELECTRON_RUN_AS_NODE',
      'ELECTRON_RENDERER_URL',
      'FOCUS_DOC',
      'IRIS_WORKSPACE_PATH',
    ]);
    // This PTY runs unattended under a hard deadline, so pager/editor/credential
    // prompts must never wait for a keystroke. See NON_INTERACTIVE_ENV.
    applyNonInteractiveEnv(env);
    const shell = commandShell(options.command, env, process.platform, options.commandShell);
    this.pty = (options.spawnFn ?? spawn)(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: options.cwd,
      env,
      encoding: null,
    });
    this.displayTimer = setTimeout(
      () => this.show(),
      options.displayThresholdMs ?? 3_000,
    );
    this.timeoutTimer = options.timeoutMs === undefined
      ? null
      : setTimeout(() => this.abort('timeout'), options.timeoutMs);
    this.mirror = options.mirrorBackpressure
      ? new TerminalMirror(80, 24, 5000, {
          highBytes: AGENT_TERMINAL_HIGH_WATER_BYTES,
          lowBytes: AGENT_TERMINAL_LOW_WATER_BYTES,
          setBlocked: (blocked) => this.flow.setBlocked('mirror', blocked),
        })
      : new TerminalMirror(80, 24, 5000);
    this.disposables.push(
      this.pty.onData((data) => this.acceptOutput(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'))),
      this.pty.onExit((event) => void this.finish(event.exitCode, event.signal)),
    );
  }

  /**
   * Delivery pressure from the owner's output batcher: an attached terminal
   * dialog that has not acknowledged its backlog stops the producer instead of
   * queueing unbounded bytes in the main process.
   */
  setOutputBlocked(blocker: 'renderer', blocked: boolean): void {
    this.flow.setBlocked(blocker, blocked);
  }

  private applyPtyPause(paused: boolean): void {
    if (this.settled) return;
    try {
      if (paused) this.pty.pause();
      else this.pty.resume();
    } catch {
      // A PTY that exited between the decision and this call cannot be paused;
      // teardown already owns the cleanup, so the race is not an error.
    }
  }

  abort(reason: 'user' | 'timeout' = 'user'): void {
    if (this.settled || this.aborting) return;
    this.aborting = true;
    this.termination = reason === 'timeout' ? 'timeout' : 'aborted';
    const killTree = this.options.processTreeKillFn;
    if (!killTree || !this.pty.pid) {
      this.pty.kill();
      this.cleanupPromise = Promise.resolve();
      return;
    }
    this.cleanupPromise = killTree(this.pty.pid)
      .catch(() => undefined)
      .finally(() => {
        if (!this.settled) this.pty.kill();
      });
  }

  dispose(): void {
    if (this.settled) this.mirror.dispose();
  }

  write(data: string): void {
    if (!this.settled) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.settled || cols < 20 || rows < 5) return;
    this.pty.resize(cols, rows);
    this.mirror.resize(cols, rows);
  }

  /**
   * Serializes the current screen. The reply carries no sequence: delivery
   * order is owned by the owner's output batcher, which flushes and freezes its
   * boundary before asking for this snapshot.
   */
  async replay(): Promise<{ data: string }> {
    await this.mirror.fence(250, () => undefined);
    return {
      data: Buffer.from(this.mirror.serialize(5000), 'utf8').toString('base64'),
    };
  }

  async observation(): Promise<{ cursor: number; text: string; running: boolean }> {
    await this.mirror.fence(250, () => undefined);
    return { cursor: this.cursor, text: this.mirror.plainText(5000), running: !this.settled };
  }

  private acceptOutput(bytes: Buffer): void {
    if (this.settled) return;
    const startCursor = this.cursor;
    this.cursor += bytes.length;
    const plainChunk = this.outputDecoder.write(bytes);
    if (plainChunk) {
      this.outputLineCount += countNewlines(plainChunk);
      this.mirror.write(plainChunk);
    }
    const store = this.options.outputStore ?? fileOutputStore;
    this.outputChain = this.outputChain.then(() => store.append(this.options.outputPath, bytes));
    this.options.onEvent?.({
      type: 'output',
      terminalId: this.options.terminalId,
      cursor: startCursor,
      bytes,
    });
  }

  private show(): void {
    if (this.settled || this.shown) return;
    this.shown = true;
    this.options.onEvent?.({ type: 'shown', terminalId: this.options.terminalId });
  }

  private async finish(exitCode: number, signal?: number): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.displayTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    for (const disposable of this.disposables) disposable.dispose();
    try {
      await this.cleanupPromise;
      await this.outputChain;
      const finalChunk = this.outputDecoder.end();
      if (finalChunk) {
        this.outputLineCount += countNewlines(finalChunk);
        this.mirror.write(finalChunk);
      }
      await this.mirror.fence(250, () => undefined);
    } catch (error) {
      this.rejectResult(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const result: AgentCommandPtyResult = {
      terminalId: this.options.terminalId,
      exitCode,
      ...(signal === undefined ? {} : { signal }),
      outputPath: this.options.outputPath,
      outputBytes: this.cursor,
      finalCursor: this.cursor,
      shown: this.shown,
      plainText: this.mirror.plainText(5000),
      outputTruncated: this.outputLineCount > 5000,
      ...(this.termination === 'natural' ? {} : { termination: this.termination }),
    };
    this.options.onEvent?.({ type: 'completed', terminalId: this.options.terminalId, result });
    this.resolveResult(result);
  }
}

function countNewlines(value: string): number {
  let count = 0;
  for (const char of value) if (char === '\n') count += 1;
  return count;
}

export function commandShell(
  command: string,
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  resolvedShell: AgentCommandShell = resolveAgentCommandShell(env, platform),
): { file: string; args: string[] } {
  if (resolvedShell.kind === 'powershell') {
    return {
      file: resolvedShell.executable,
      args: ['-NoLogo', '-NoProfile', '-Command', command],
    };
  }
  return { file: resolvedShell.executable, args: ['-lc', command] };
}

export function resolveAgentCommandShell(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
): AgentCommandShell {
  if (platform !== 'win32') {
    const executable = env.SHELL || '/bin/bash';
    return { kind: 'posix', executable, displayName: executable };
  }

  const pathDirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const hasPwsh = pathDirs.some((directory) =>
    fileExists(`${directory.replace(/[\\/]+$/u, '')}\\pwsh.exe`));
  return hasPwsh
    ? { kind: 'powershell', executable: 'pwsh.exe', displayName: 'PowerShell 7' }
    : {
        kind: 'powershell',
        executable: 'powershell.exe',
        displayName: 'Windows PowerShell',
      };
}

const fileOutputStore: AgentCommandOutputStore = {
  async append(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, bytes);
  },
};
