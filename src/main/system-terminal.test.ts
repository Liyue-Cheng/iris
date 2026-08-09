import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { launchSystemTerminal } from './system-terminal';

describe('system terminal launcher', () => {
  it('opens the shell in a new Windows Terminal window at the project root', async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, 'pid', { value: 1234 });
    child.unref = vi.fn();
    const spawnFn = vi.fn(
      (_file: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    );

    await expect(
      launchSystemTerminal('npm run dev', 'C:\\work\\iris', {
        platform: 'win32',
        env: { Path: '' },
        spawnFn,
      }),
    ).resolves.toBe(1234);
    expect(spawnFn).toHaveBeenCalledWith(
      'wt.exe',
      ['-w', 'new', '-d', 'C:\\work\\iris', 'cmd.exe', '/k', 'npm run dev'],
      expect.objectContaining({
        cwd: 'C:\\work\\iris',
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      }),
    );
    expect(child.unref).toHaveBeenCalled();
  });

  it('reports a Windows Terminal launch failure instead of falling back', async () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn wt.exe ENOENT')));
      return child;
    });

    await expect(
      launchSystemTerminal('echo ready', 'C:\\work\\iris', {
        platform: 'win32',
        env: { Path: '' },
        spawnFn,
      }),
    ).rejects.toThrow('[SystemTerminal] spawn wt.exe ENOENT');

    expect(spawnFn).toHaveBeenCalledWith(
      'wt.exe',
      ['-w', 'new', '-d', 'C:\\work\\iris', 'cmd.exe', '/k', 'echo ready'],
      expect.objectContaining({ cwd: 'C:\\work\\iris', windowsHide: false }),
    );
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('fails explicitly where no external-terminal adapter exists', async () => {
    await expect(
      launchSystemTerminal('echo hi', '/tmp/project', { platform: 'linux' }),
    ).rejects.toThrow('not supported on linux');
  });
});
