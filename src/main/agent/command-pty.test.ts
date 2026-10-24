import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { AgentCommandPty, type AgentCommandPtyOptions } from './command-pty';
import xtermHeadless from '@xterm/headless';
import { TerminalOutputBatcher } from '../terminal/output-pump';
import { applyXtermSnapshotState } from '@shared/terminal/xterm-snapshot-state';

function outputFixture(options: Partial<AgentCommandPtyOptions> = {}) {
  let output!: (data: string | Buffer) => void;
  let exit!: (event: { exitCode: number }) => void;
  const pty = {
    pid: 4242, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    onData: (callback: typeof output) => { output = callback; return { dispose() {} }; },
    onExit: (callback: typeof exit) => { exit = callback; return { dispose() {} }; },
    kill: () => exit({ exitCode: 0 }),
  } as unknown as IPty;
  const stored: Buffer[] = [];
  const delivered: Array<{ seq: number; data: string }> = [];
  const batch = new TerminalOutputBatcher((seq, data) => ({ seq, data }), (payload) => delivered.push(payload));
  const terminal = new AgentCommandPty({
    terminalId: 'output', command: '', cwd: process.cwd(), outputPath: 'unused.log',
    spawnFn: () => pty, outputStore: { append: async (_path, data) => { stored.push(data); } },
    onEvent: (event) => { if (event.bytes) batch.enqueue(event.bytes); },
    ...options,
  });
  return { terminal, pty, stored, delivered, batch, output: (data: string | Buffer) => output(data) };
}

describe('AgentCommandPty output checkpoints', () => {
  it.each(['before-exit', 'during-finish'] as const)('defers disposal %s until the final preview is complete', async (when) => {
    const settings = new EventEmitter();
    let releaseWrite!: () => void;
    const writing = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const f = outputFixture({
      outputStore: { append: () => writing },
      onColorsChanged: (listener) => {
        settings.on('settingsChanged', listener);
        return { dispose: () => { settings.off('settingsChanged', listener); } };
      },
    });
    try {
      f.output('final preview');
      // An incomplete UTF-8 character is flushed only inside finish, after
      // the artifact write resolves. Early disposal would silently lose it.
      f.output(Buffer.from([0xe4]));
      expect(settings.listenerCount('settingsChanged')).toBe(1);
      if (when === 'before-exit') f.terminal.dispose();
      f.terminal.abort();
      if (when === 'during-finish') f.terminal.dispose();
      await Promise.resolve();
      expect(settings.listenerCount('settingsChanged')).toBe(1);
      releaseWrite();
      const result = await f.terminal.result;
      expect(result.plainText).toBe('final preview�');
      expect(settings.listenerCount('settingsChanged')).toBe(0);
      await expect(f.terminal.replay()).rejects.toThrow('disposed');
      f.terminal.dispose();
      expect(settings.listenerCount('settingsChanged')).toBe(0);
    } finally {
      releaseWrite();
      f.terminal.abort();
      await f.terminal.result;
      f.terminal.dispose();
      f.batch.dispose({ flush: false });
    }
  });

  it('releases a requested disposal when final artifact persistence fails', async () => {
    const settings = new EventEmitter();
    let failWrite!: (error: Error) => void;
    const writing = new Promise<void>((_resolve, reject) => { failWrite = reject; });
    const f = outputFixture({
      outputStore: { append: () => writing },
      onColorsChanged: (listener) => {
        settings.on('settingsChanged', listener);
        return { dispose: () => { settings.off('settingsChanged', listener); } };
      },
    });
    try {
      f.output('output');
      f.terminal.abort();
      f.terminal.dispose();
      const result = expect(f.terminal.result).rejects.toThrow('artifact failed');
      failWrite(new Error('artifact failed'));
      await result;
      expect(settings.listenerCount('settingsChanged')).toBe(0);
      await expect(f.terminal.replay()).rejects.toThrow('disposed');
    } finally {
      f.terminal.abort();
      await f.terminal.result.catch(() => undefined);
      f.terminal.dispose();
      f.batch.dispose({ flush: false });
    }
  });

  it('retains program colors in checkpoints after the process exits', async () => {
    const f = outputFixture();
    try {
      f.output('\x1b]4;1;#123456\x07done');
      await f.terminal.replay();
      f.terminal.abort();
      await f.terminal.result;
      const replay = await f.terminal.replay();
      expect(Buffer.from(replay.data, 'base64').toString('utf8')).toContain('\x1b]4;1;rgb:1212/3434/5656\x1b\\');
    } finally { f.terminal.abort(); await f.terminal.result; f.terminal.dispose(); f.batch.dispose({ flush: false }); }
  });

  it('keeps UTF-8 fragments out of the sequence boundary and preserves the raw artifact', async () => {
    const f = outputFixture();
    const restored = new xtermHeadless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const bytes = Buffer.from('中文');
    try {
      f.output(bytes.subarray(0, 1));
      f.batch.flush();
      const seq = f.batch.replayBoundarySeq;
      expect(seq).toBe(-1);
      const replay = await f.terminal.replay();
      f.output(bytes.subarray(1));
      f.batch.flush();
      await new Promise<void>((done) => restored.write(Buffer.from(replay.data, 'base64'), done));
      applyXtermSnapshotState(restored, replay.continuationState);
      for (const payload of f.delivered.filter((item) => item.seq > seq)) {
        await new Promise<void>((done) => restored.write(Buffer.from(payload.data, 'base64'), done));
      }
      expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe('中文');
      f.terminal.abort();
      const result = await f.terminal.result;
      expect(result.outputBytes).toBe(bytes.length);
      expect(Buffer.concat(f.stored)).toEqual(bytes);
    } finally { f.terminal.abort(); await f.terminal.result; f.terminal.dispose(); f.batch.dispose({ flush: false }); restored.dispose(); }
  });

  it('captures inside the parser fence and replies without a dialog', async () => {
    const f = outputFixture();
    const restored = new xtermHeadless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      f.output('A');
      f.batch.flush();
      const seq = f.batch.replayBoundarySeq;
      const pending = f.terminal.replay();
      f.output('B');
      const replay = await pending;
      f.batch.flush();
      await new Promise<void>((done) => restored.write(Buffer.from(replay.data, 'base64'), done));
      applyXtermSnapshotState(restored, replay.continuationState);
      for (const payload of f.delivered.filter((item) => item.seq > seq)) {
        await new Promise<void>((done) => restored.write(Buffer.from(payload.data, 'base64'), done));
      }
      expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe('AB');
      f.output('\x1b[6n\x1b]10;?\x07');
      await f.terminal.replay();
      expect(f.pty.write).toHaveBeenCalledWith('\x1b[1;3R');
      expect(f.pty.write).toHaveBeenCalledTimes(2);
    } finally { f.terminal.abort(); await f.terminal.result; f.terminal.dispose(); f.batch.dispose({ flush: false }); restored.dispose(); }
  });
});

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
