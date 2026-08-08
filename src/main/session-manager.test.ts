import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { SessionOutputPayload } from '@shared/types';
import type { SettingsManager } from './settings-manager';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { ensureFocusScriptCurrent, FOCUS_CONTEXT_SCRIPT } from './agent-injection';
import { logger } from './logger';
import { SessionManager, type CreateSessionInput, type PtySpawnFn } from './session-manager';

interface PendingEmitHarness {
  info: { id: string };
  scrollbackLastSeq: number;
  pendingEmit: { chunks: Buffer[]; totalBytes: number; lastSeq: number } | null;
  pendingEmitTimer: NodeJS.Timeout | null;
}

type QueueEmit = (managed: PendingEmitHarness, bytes: Buffer, seq: number) => void;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fakePty(): IPty {
  const disposable = { dispose: vi.fn() };
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const pty = {
    pid: 4242,
    onData: vi.fn(() => disposable),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.add(listener);
      return { dispose: vi.fn(() => exitListeners.delete(listener)) };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(() => {
      for (const listener of [...exitListeners]) listener({ exitCode: 1 });
    }),
  } as unknown as IPty;
  return pty;
}

function controllablePty(): {
  pty: IPty;
  emitData: (data: string) => void;
  emitExit: (exitCode?: number) => void;
} {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const emitData = (data: string): void => {
    for (const listener of [...dataListeners]) listener(data);
  };
  const emitExit = (exitCode = 1): void => {
    for (const listener of [...exitListeners]) listener({ exitCode });
  };
  const pty = {
    pid: 4242,
    onData: vi.fn((listener: (data: string) => void) => {
      dataListeners.add(listener);
      return { dispose: vi.fn(() => dataListeners.delete(listener)) };
    }),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.add(listener);
      return { dispose: vi.fn(() => exitListeners.delete(listener)) };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
  } as unknown as IPty;
  return { pty, emitData, emitExit };
}

function fakeSettingsManager(): SettingsManager {
  return {
    get: () => ({
      agents: [{ id: 'shell', label: 'shell', command: '' }],
      advanced: { activeIdleThresholdSeconds: 2 },
    }),
  } as unknown as SettingsManager;
}

async function spawnEnvFor(
  input: Pick<CreateSessionInput, 'docPath' | 'workspacePath'>,
): Promise<Record<string, string>> {
  let capturedEnv: Record<string, string> | null = null;
  const spawnFn: PtySpawnFn = (_file, _args, options) => {
    capturedEnv = { ...options.env };
    return fakePty();
  };
  const manager = new SessionManager(fakeSettingsManager(), {
    spawnFn,
    processTreeKillFn: null,
    ptyExitWaitMs: 0,
  });
  manager.createSession({
    ...input,
    agentId: 'shell',
    projectRoot: process.cwd(),
    projectGeneration: 1,
    cols: 80,
    rows: 24,
  });
  await manager.shutdown();
  if (!capturedEnv) throw new Error('PTY spawn did not capture an environment');
  return capturedEnv;
}

describe('session context environment', () => {
  it('injects only FOCUS_DOC for a document session', async () => {
    vi.stubEnv('IRIS_WORKSPACE_PATH', '.iris/stale-workspace');

    const env = await spawnEnvFor({
      docPath: '.iris/issue/example.md',
      workspacePath: '.iris/ignored-workspace',
    });

    expect(env.FOCUS_DOC).toBe('.iris/issue/example.md');
    expect(env.IRIS_WORKSPACE_PATH).toBeUndefined();
  });

  it('injects the root workspace for a root hub session', async () => {
    vi.stubEnv('FOCUS_DOC', '.iris/issue/stale-focus.md');

    const env = await spawnEnvFor({ docPath: null });

    expect(env.FOCUS_DOC).toBeUndefined();
    expect(env.IRIS_WORKSPACE_PATH).toBe('.iris');
  });

  it('injects the actual nested workspace for a nested hub session', async () => {
    const env = await spawnEnvFor({
      docPath: null,
      workspacePath: '.iris/areas/platform',
    });

    expect(env.FOCUS_DOC).toBeUndefined();
    expect(env.IRIS_WORKSPACE_PATH).toBe('.iris/areas/platform');
  });
});

describe('session shutdown', () => {
  it('drains only the requested project generation and remains reusable', async () => {
    const manager = new SessionManager(fakeSettingsManager(), {
      spawnFn: () => fakePty(),
      processTreeKillFn: null,
      ptyExitWaitMs: 0,
    });
    const root = process.cwd();
    manager.createSession({
      docPath: null,
      agentId: 'shell',
      projectRoot: root,
      projectGeneration: 1,
      cols: 80,
      rows: 24,
    });
    const current = manager.createSession({
      docPath: null,
      agentId: 'shell',
      projectRoot: root,
      projectGeneration: 2,
      cols: 80,
      rows: 24,
    });

    await manager.closeProject({ root, generation: 1 });

    expect(manager.list().map((item) => item.id)).toEqual([current.id]);
    await manager.shutdown();
  });

  it('kills the Windows process tree before closing node-pty and waits for exit', async () => {
    const order: string[] = [];
    const controlled = controllablePty();
    const spawnFn: PtySpawnFn = () => controlled.pty;
    const processTreeKillFn = vi.fn(async (pid: number) => {
      order.push(`tree:${pid}`);
      controlled.emitExit();
      order.push('exit');
    });
    vi.mocked(controlled.pty.kill).mockImplementation(() => {
      order.push('pty.kill');
    });
    const manager = new SessionManager(fakeSettingsManager(), {
      spawnFn,
      processTreeKillFn,
      ptyExitWaitMs: 100,
    });
    manager.createSession({
      docPath: null,
      agentId: 'shell',
      projectRoot: process.cwd(),
      projectGeneration: 1,
      cols: 80,
      rows: 24,
    });

    const firstShutdown = manager.shutdown();
    const secondShutdown = manager.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    await firstShutdown;

    expect(processTreeKillFn).toHaveBeenCalledOnce();
    expect(processTreeKillFn).toHaveBeenCalledWith(4242);
    expect(order).toEqual(['tree:4242', 'exit', 'pty.kill']);
    expect(manager.list()).toEqual([]);
  });

  it('still closes node-pty when process-tree termination fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const controlled = controllablePty();
    vi.mocked(controlled.pty.kill).mockImplementation(() => controlled.emitExit());
    const manager = new SessionManager(fakeSettingsManager(), {
      spawnFn: () => controlled.pty,
      processTreeKillFn: vi.fn().mockRejectedValue(new Error('taskkill failed')),
      ptyExitWaitMs: 100,
    });
    const session = manager.createSession({
      docPath: null,
      agentId: 'shell',
      projectRoot: process.cwd(),
      projectGeneration: 1,
      cols: 80,
      rows: 24,
    });

    await expect(manager.closeSession(session.id)).resolves.toBeUndefined();

    expect(controlled.pty.kill).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'session',
      expect.stringContaining('process-tree kill failed'),
      expect.any(Error),
    );
    expect(manager.list()).toEqual([]);
  });
});

describe('focus-context PowerShell contract', () => {
  it('keeps all Iris-owned hook prompts in English', () => {
    expect(FOCUS_CONTEXT_SCRIPT).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it.runIf(process.platform === 'win32')(
    'distinguishes document, hub, and ordinary external terminals',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'iris-focus-context-'));
      const scriptPath = join(dir, 'focus-context.ps1');
      writeFileSync(scriptPath, `\uFEFF${FOCUS_CONTEXT_SCRIPT}`, 'utf8');

      const run = (context: { focus?: string; workspace?: string }): string => {
        const env = { ...process.env };
        delete env.FOCUS_DOC;
        delete env.IRIS_WORKSPACE_PATH;
        if (context.focus) env.FOCUS_DOC = context.focus;
        if (context.workspace) env.IRIS_WORKSPACE_PATH = context.workspace;
        return execFileSync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
          { cwd: process.cwd(), env, encoding: 'utf8' },
        );
      };

      try {
        expect(run({})).toBe('');

        const focusPath = 'fixtures/sample-project/.iris/status/architecture.md';
        const documentOutput = run({ focus: focusPath });
        expect(documentOutput).toContain(`focused document: ${focusPath}`);
        expect(documentOutput).toContain(`<iris-focus path="${focusPath}">`);
        expect(documentOutput).not.toContain('<iris-workspace');

        const rootHubOutput = run({ workspace: '.iris' });
        expect(rootHubOutput).toContain('workspace: .iris');
        expect(rootHubOutput).toContain('<iris-workspace path=".iris">');
        expect(rootHubOutput).toContain('This is a project-root hub session');
        expect(rootHubOutput).toContain('FOCUS_DOC is unset');
        expect(rootHubOutput).toContain('Do not read or infer a focused document');
        expect(rootHubOutput).toContain('</iris-workspace>');
        expect(rootHubOutput).not.toContain('<iris-software');
        expect(rootHubOutput).not.toContain('<iris-project');
        expect(rootHubOutput).not.toContain('<iris-user');
        expect(rootHubOutput).not.toContain('<iris-focus path=');

        const nestedHubOutput = run({ workspace: '.iris/areas/platform' });
        expect(nestedHubOutput).toContain('<iris-workspace path=".iris/areas/platform">');
        expect(nestedHubOutput).toContain(
          'This is a workspace hub session opened from .iris/areas/platform',
        );
        expect(nestedHubOutput).toContain('Do not read or infer a focused document');
        expect(nestedHubOutput).not.toContain('<iris-focus path=');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('focus-context script lifecycle', () => {
  it('creates missing scripts, updates stale scripts, and leaves current scripts untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-focus-script-sync-'));
    const scriptPath = join(dir, 'focus-context.ps1');

    try {
      await expect(ensureFocusScriptCurrent(scriptPath)).resolves.toEqual({
        path: scriptPath,
        action: 'created',
      });
      const current = readFileSync(scriptPath, 'utf8');
      expect(current).toBe(`\uFEFF${FOCUS_CONTEXT_SCRIPT}`);

      writeFileSync(scriptPath, '\uFEFF# stale Iris focus-context', 'utf8');
      await expect(ensureFocusScriptCurrent(scriptPath)).resolves.toEqual({
        path: scriptPath,
        action: 'updated',
      });
      expect(readFileSync(scriptPath, 'utf8')).toBe(current);

      await expect(ensureFocusScriptCurrent(scriptPath)).resolves.toEqual({
        path: scriptPath,
        action: 'unchanged',
      });
      expect(readFileSync(scriptPath, 'utf8')).toBe(current);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('session output batching', () => {
  it('concatenates a high chunk-count batch only once when it flushes', () => {
    vi.useFakeTimers();
    const manager = new SessionManager({} as SettingsManager);
    const queueEmit = (manager as unknown as { queueEmit: QueueEmit }).queueEmit.bind(manager);
    const managed: PendingEmitHarness = {
      info: { id: 'session-1' },
      scrollbackLastSeq: -1,
      pendingEmit: null,
      pendingEmitTimer: null,
    };
    const emitted: SessionOutputPayload[] = [];
    manager.on('sessionOutput', (payload: SessionOutputPayload) => emitted.push(payload));
    const concatSpy = vi.spyOn(Buffer, 'concat');

    const chunkCount = 10_000;
    for (let seq = 0; seq < chunkCount; seq += 1) {
      queueEmit(managed, Buffer.from('x'), seq);
    }

    expect(concatSpy).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(8);

    expect(concatSpy).toHaveBeenCalledTimes(1);
    expect(concatSpy).toHaveBeenCalledWith(expect.any(Array), chunkCount);
    expect(emitted).toHaveLength(1);
    const payload = emitted[0]!;
    expect(Buffer.from(payload.data, 'base64').toString('utf8')).toBe('x'.repeat(chunkCount));
    expect(payload.seq).toBe(chunkCount - 1);
    expect(managed.scrollbackLastSeq).toBe(chunkCount - 1);
  });
});

describe('terminal scrollback compatibility', () => {
  it('preserves history when a synchronized Codex redraw clears the display', async () => {
    const controlled = controllablePty();
    vi.mocked(controlled.pty.kill).mockImplementation(() => controlled.emitExit());
    const manager = new SessionManager(fakeSettingsManager(), {
      spawnFn: () => controlled.pty,
      processTreeKillFn: null,
      ptyExitWaitMs: 100,
    });
    const session = manager.createSession({
      docPath: null,
      agentId: 'shell',
      projectRoot: process.cwd(),
      projectGeneration: 1,
      cols: 20,
      rows: 5,
    });

    controlled.emitData(
      Array.from({ length: 12 }, (_, index) => `old-${index}\r\n`).join(''),
    );
    // Codex inserts history with a partial DECSTBM region, resets it, then
    // redraws in a synchronized frame. Split every boundary as ConPTY may do.
    controlled.emitData('\x1b[2;4');
    controlled.emitData('r\x1b[');
    controlled.emitData('r\x1b[?20');
    controlled.emitData('26h\x1b[2');
    controlled.emitData('J\x1b[Hnew-1\r\nnew-2\x1b[?2026l');

    const replay = await manager.prepareReplay(session.id, 20, 5);
    const ansi = Buffer.from(replay.data, 'base64').toString('utf8');

    expect(ansi).toContain('old-8');
    expect(ansi).toContain('old-11');
    expect(ansi).toContain('new-1');
    expect(ansi).toContain('new-2');
    expect(ansi).not.toContain('\x1b[2;4r');

    await manager.shutdown();
  });
});
