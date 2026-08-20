import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IDisposable, IPty } from 'node-pty';
import {
  AgentCommandPty,
  commandShell,
  resolveAgentCommandShell,
  type AgentCommandPtyEvent,
} from './command-pty';

function fakePty() {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  const disposable = (): IDisposable => ({ dispose: vi.fn() });
  const pty = {
    pid: 42,
    cols: 80,
    rows: 24,
    process: 'shell',
    handleFlowControl: false,
    onData: (listener: (data: string) => void) => {
      dataListener = listener;
      return disposable();
    },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListener = listener;
      return disposable();
    },
    resize: vi.fn(),
    clear: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  } satisfies IPty;
  return {
    pty,
    data: (value: string | Buffer) =>
      (dataListener as unknown as ((data: string | Buffer) => void) | null)?.(value),
    exit: (exitCode: number) =>
      (exitListener as ((event: { exitCode: number }) => void) | null)?.({ exitCode }),
  };
}

describe('AgentCommandPty', () => {
  it('keeps a command under the threshold compact and completes once after output persistence', async () => {
    vi.useFakeTimers();
    const fake = fakePty();
    const events: AgentCommandPtyEvent[] = [];
    const stored: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const command = new AgentCommandPty({
      terminalId: 'terminal-1',
      command: 'echo ok',
      cwd: process.cwd(),
      outputPath: 'output.bin',
      spawnFn: () => fake.pty,
      outputStore: {
        append: async (_path, bytes) => {
          await gate;
          stored.push(bytes.toString());
        },
      },
      onEvent: (event) => events.push(event),
    });
    fake.data('ok');
    fake.exit(0);
    fake.exit(0);
    expect(events.filter((event) => event.type === 'completed')).toHaveLength(0);
    release();
    await vi.advanceTimersByTimeAsync(250);
    const result = await command.result;
    expect(result).toMatchObject({ outputBytes: 2, finalCursor: 2, shown: false });
    expect(stored).toEqual(['ok']);
    expect(events.filter((event) => event.type === 'completed')).toHaveLength(1);
    vi.useRealTimers();
  });

  it('shows a still-running command once at the threshold and retains monotonic cursors', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakePty();
      const events: AgentCommandPtyEvent[] = [];
      const command = new AgentCommandPty({
        terminalId: 'terminal-2',
        command: 'long',
        cwd: process.cwd(),
        outputPath: 'output.bin',
        spawnFn: () => fake.pty,
        outputStore: { append: async () => {} },
        onEvent: (event) => events.push(event),
      });
      fake.data('one');
      fake.data('two');
      vi.advanceTimersByTime(3_000);
      vi.advanceTimersByTime(3_000);
      fake.exit(7);
      await vi.advanceTimersByTimeAsync(250);
      const result = await command.result;
      expect(events.filter((event) => event.type === 'shown')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'output').map((event) => event.cursor)).toEqual([
        0, 3,
      ]);
      expect(result).toMatchObject({ exitCode: 7, finalCursor: 6, shown: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects instead of hanging when full-output persistence fails', async () => {
    const fake = fakePty();
    const command = new AgentCommandPty({
      terminalId: 'terminal-write-failure',
      command: 'echo fail',
      cwd: process.cwd(),
      outputPath: 'output.bin',
      spawnFn: () => fake.pty,
      outputStore: { append: async () => Promise.reject(new Error('disk full')) },
    });
    fake.data('not persisted');
    fake.exit(0);
    await expect(command.result).rejects.toThrow('disk full');
  });

  it('only kills the PTY when explicitly aborted', async () => {
    const fake = fakePty();
    const command = new AgentCommandPty({
      terminalId: 'terminal-abort',
      command: 'long',
      cwd: process.cwd(),
      outputPath: 'output.bin',
      spawnFn: () => fake.pty,
      outputStore: { append: async () => {} },
    });
    command.abort();
    expect(fake.pty.kill).toHaveBeenCalledOnce();
    fake.exit(130);
    await expect(command.result).resolves.toMatchObject({ exitCode: 130 });
  });

  it('decodes UTF-8 text across raw PTY chunk boundaries', async () => {
    const fake = fakePty();
    const command = new AgentCommandPty({
      terminalId: 'terminal-utf8',
      command: 'unicode',
      cwd: process.cwd(),
      outputPath: 'output.bin',
      spawnFn: () => fake.pty,
      outputStore: { append: async () => {} },
    });
    const bytes = Buffer.from('你好', 'utf8');
    fake.data(bytes.subarray(0, 2));
    fake.data(bytes.subarray(2, 4));
    fake.data(bytes.subarray(4));
    fake.exit(0);
    await expect(command.result).resolves.toMatchObject({ plainText: '你好' });
  });

  it('uses a one-shot non-interactive shell command', () => {
    expect(commandShell('echo ok', { SHELL: '/bin/zsh' }, 'linux')).toEqual({
      file: '/bin/zsh',
      args: ['-lc', 'echo ok'],
    });
    expect(commandShell('echo ok', { PATH: '' }, 'win32')).toEqual({
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-Command', 'echo ok'],
    });
  });

  it('resolves PowerShell 7 by executable presence and otherwise uses Windows PowerShell', () => {
    expect(resolveAgentCommandShell(
      { PATH: 'C:\\Tools;C:\\Program Files\\PowerShell\\7\\' },
      'win32',
      (path) => path === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    )).toEqual({
      kind: 'powershell',
      executable: 'pwsh.exe',
      displayName: 'PowerShell 7',
    });
    expect(resolveAgentCommandShell({ PATH: '' }, 'win32', () => false)).toEqual({
      kind: 'powershell',
      executable: 'powershell.exe',
      displayName: 'Windows PowerShell',
    });
  });

  it.runIf(process.platform === 'win32')(
    'runs a real independent ConPTY and persists its complete output',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'iris-agent-pty-'));
      const outputPath = join(dir, 'terminal.bin');
      try {
        const events: AgentCommandPtyEvent[] = [];
        const command = new AgentCommandPty({
          terminalId: 'terminal-real',
          command: "[Console]::Write('alpha'); Start-Sleep -Milliseconds 80; [Console]::Write('omega')",
          cwd: process.cwd(),
          outputPath,
          displayThresholdMs: 20,
          onEvent: (event) => events.push(event),
        });
        const result = await command.result;
        const stored = await readFile(outputPath, 'utf8');
        expect(result).toMatchObject({ exitCode: 0, shown: true });
        expect(stored).toContain('alpha');
        expect(stored).toContain('omega');
        expect(result.outputBytes).toBe(Buffer.byteLength(stored));
        expect(events.filter((event) => event.type === 'completed')).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
