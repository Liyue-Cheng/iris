import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { SettingsManager } from './settings-manager';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import {
  ensureFocusScriptCurrent,
  FOCUS_CONTEXT_SCRIPT,
  removeIrisHookHandlers,
} from './agent-injection';
import { logger } from './logger';
import { SessionManager, type CreateSessionInput, type PtySpawnFn } from './session-manager';

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
      appearance: { theme: 'rose-pine' },
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
  it('runs an arbitrary custom launcher command without an injection mode', async () => {
    let capturedArgs: string[] = [];
    const command = 'custom-agent --profile work';
    const settingsManager = {
      get: () => ({
        agents: [{ id: 'custom', label: 'Custom agent', command }],
        advanced: { activeIdleThresholdSeconds: 2 },
      }),
    } as unknown as SettingsManager;
    const manager = new SessionManager(settingsManager, {
      spawnFn: (_file, args) => {
        capturedArgs = [...args];
        return fakePty();
      },
      processTreeKillFn: null,
      ptyExitWaitMs: 0,
    });

    const session = manager.createSession({
      docPath: '.iris/issue/custom.md',
      agentId: 'custom',
      projectRoot: process.cwd(),
      projectGeneration: 1,
      cols: 80,
      rows: 24,
    });

    expect(capturedArgs.some((arg) => arg.includes(command))).toBe(true);
    if (process.platform === 'win32') {
      expect(capturedArgs.includes('-NoExit') || capturedArgs.includes('/k')).toBe(true);
    } else {
      expect(capturedArgs.some((arg) => arg.includes('exec'))).toBe(true);
    }
    expect(session.agentId).toBe('custom');
    expect(session.displayName).toBe('Custom agent');
    await manager.shutdown();
  });

  it('runs a project toolbar command in a fresh root hub session', async () => {
    let capturedArgs: string[] = [];
    let capturedCwd = '';
    let capturedEnv: Record<string, string> = {};
    const manager = new SessionManager(fakeSettingsManager(), {
      spawnFn: (_file, args, options) => {
        capturedArgs = [...args];
        capturedCwd = options.cwd;
        capturedEnv = { ...options.env };
        return fakePty();
      },
      processTreeKillFn: null,
      ptyExitWaitMs: 0,
    });
    const command = 'npm run verify';
    const session = manager.createCommandSession({
      actionIndex: 2,
      description: 'Verify project',
      command,
      projectRoot: process.cwd(),
      projectGeneration: 3,
      cols: 100,
      rows: 30,
    });

    expect(capturedArgs.some((arg) => arg.includes(command))).toBe(true);
    expect(capturedCwd).toBe(process.cwd());
    expect(capturedEnv.FOCUS_DOC).toBeUndefined();
    expect(capturedEnv.IRIS_WORKSPACE_PATH).toBe('.iris');
    expect(session).toMatchObject({
      docPath: null,
      workspacePath: '.iris',
      agentId: 'project-action:2',
      displayName: 'Verify project',
      projectGeneration: 3,
    });
    await manager.shutdown();
  });

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

describe('Iris hook config removal', () => {
  it('removes only Iris handlers and preserves unrelated config', () => {
    const otherHandler = { type: 'command', command: 'write-host keep-me' };
    const config: Record<string, unknown> = {
      theme: 'custom',
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              { type: 'command', command: 'powershell -File "C:/Users/me/.iris/focus-context.ps1"' },
              otherHandler,
            ],
          },
          {
            matcher: 'resume',
            hooks: [{ type: 'command', command: 'powershell -File focus-context.ps1' }],
          },
        ],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'audit-tool' }] }],
      },
    };

    expect(removeIrisHookHandlers(config, 'SessionStart')).toBe(true);
    expect(config).toEqual({
      theme: 'custom',
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [otherHandler] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'audit-tool' }] }],
      },
    });
  });

  it('does not rewrite config when no Iris handler exists', () => {
    const config: Record<string, unknown> = {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] },
    };
    const before = structuredClone(config);

    expect(removeIrisHookHandlers(config, 'SessionStart')).toBe(false);
    expect(config).toEqual(before);
  });
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

describe('terminal scrollback compatibility', () => {
  it('emits only for the attached runtime and rejects stale detach tokens', async () => {
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
    const output: string[] = [];
    manager.on('sessionOutput', (payload: { data: string }) => {
      output.push(Buffer.from(payload.data, 'base64').toString());
    });

    controlled.emitData('hidden');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(output).toEqual([]);

    expect(manager.attachOutput(session.id, 'runtime:2')).toBe(true);
    controlled.emitData('visible');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(output).toEqual(['visible']);

    manager.detachOutput('runtime:1');
    controlled.emitData('still-visible');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(output).toEqual(['visible', 'still-visible']);

    manager.detachOutput('runtime:2');
    controlled.emitData('hidden-again');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(output).toEqual(['visible', 'still-visible']);
    await manager.shutdown();
  });

  it('answers OSC color queries in main and removes them from renderer output', async () => {
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

    controlled.emitData('before\x1b]10;');
    controlled.emitData('?\x07after');
    const replay = await manager.prepareReplay(session.id, 20, 5);
    const ansi = Buffer.from(replay.data, 'base64').toString('utf8');

    expect(controlled.pty.write).toHaveBeenCalledWith(
      '\x1b]10;rgb:e0e0/dede/f4f4\x07',
    );
    expect(ansi).toContain('beforeafter');
    expect(ansi).not.toContain(']10;?');
    await manager.shutdown();
  });

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
