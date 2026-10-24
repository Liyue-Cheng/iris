import { describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { AgentCommandPty } from './command-pty';

describe('AgentCommandPty input', () => {
  it('preserves binary mouse bytes at the PTY boundary alongside text input', async () => {
    let onExit: ((event: { exitCode: number }) => void) | undefined;
    const write = vi.fn();
    const pty = {
      pid: 4242,
      onData: () => ({ dispose() {} }),
      onExit: (listener: typeof onExit) => { onExit = listener; return { dispose() {} }; },
      write,
      kill: () => onExit?.({ exitCode: 1 }),
    } as unknown as IPty;
    const terminal = new AgentCommandPty({
      terminalId: 'mouse-test', command: '', cwd: process.cwd(), outputPath: 'unused.log',
      spawnFn: () => pty, outputStore: { append: async () => undefined },
    });
    try {
      const mouse = Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0xc8, 0xff]);
      terminal.write(mouse);
      terminal.write('中文\r');
      expect(write).toHaveBeenNthCalledWith(1, mouse);
      expect(write).toHaveBeenNthCalledWith(2, '中文\r');
    } finally {
      terminal.abort();
      await terminal.result;
      terminal.dispose();
    }
  });
});
