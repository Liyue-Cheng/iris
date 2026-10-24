import { describe, expect, it, vi } from 'vitest';
import xtermHeadless from '@xterm/headless';
import { TerminalMirror } from './terminal-mirror';
import { applyXtermSnapshotState, captureXtermSnapshotState } from '../../shared/terminal/xterm-snapshot-state';

type Terminal = InstanceType<typeof xtermHeadless.Terminal>;

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function screen(terminal: Terminal): unknown {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) => {
    const line = buffer.getLine(buffer.baseY + row);
    return Array.from({ length: terminal.cols }, (_, col) => {
      const cell = line?.getCell(col);
      return cell && [cell.getChars(), cell.getWidth(), cell.getFgColor(), cell.getBgColor(),
        cell.isBold(), cell.isItalic(), cell.isUnderline(), cell.isInverse(), cell.isDim()];
    });
  });
}

async function restoredSnapshot(mirror: TerminalMirror, target: Terminal, scrollback = 100): Promise<void> {
  const snapshot = await mirror.snapshot(scrollback, 1000);
  await write(target, snapshot.data + '\x1b[?2026l');
  applyXtermSnapshotState(target, structuredClone(snapshot.continuationState));
  await write(target, snapshot.parserTail);
}

describe('TerminalMirror', () => {
  it.each([
    ['default', '', 2, 2],
    ['SGR', '\x1b[?1006h', 1, 2],
    ['SGR pixels', '\x1b[?1016h', 2, 1],
    ['disabled SGR', '\x1b[?1006h\x1b[?1006l', 2, 2],
  ] as const)('restores %s mouse encoding along with tracking on replay', async (_name, encoding, sgr, pixels) => {
    const mirror = new TerminalMirror(120, 30, 100);
    const restored = new xtermHeadless.Terminal({ cols: 120, rows: 30, allowProposedApi: true });
    const replies: string[] = [];
    restored.onData((data) => replies.push(data));
    try {
      mirror.write(`\x1b[?1003h${encoding}screen`);
      await mirror.fence(100, () => { throw new Error('unexpected fence timeout'); });
      // A resync must also replace an encoding left over in the existing view.
      await new Promise<void>((resolve) => restored.write(pixels === 1 ? '\x1b[?1006h' : '\x1b[?1016h', resolve));
      await new Promise<void>((resolve) => restored.write(mirror.serialize(100), resolve));
      await new Promise<void>((resolve) => restored.write('\x1b[?1006$p\x1b[?1016$p', resolve));
      expect(restored.modes.mouseTrackingMode).toBe('any');
      expect(replies).toEqual([`\x1b[?1006;${sgr}$y`, `\x1b[?1016;${pixels}$y`]);
    } finally {
      restored.dispose();
      mirror.dispose();
    }
  });

  it('owns parsing, fencing and serialization behind a narrow interface', async () => {
    const mirror = new TerminalMirror(20, 5, 100);
    mirror.write('hello\r\nworld');
    await mirror.fence(100, () => {
      throw new Error('unexpected fence timeout');
    });
    const ansi = mirror.serialize(100);
    expect(ansi).toContain('hello');
    expect(ansi).toContain('world');
    mirror.dispose();
  });

  it('tracks alternate buffer ownership without exposing xterm internals', async () => {
    const mirror = new TerminalMirror(20, 5, 100);
    mirror.write('\x1b[?1049hfull screen');
    await mirror.fence(100, () => undefined);
    expect(mirror.activeBufferType).toBe('alternate');
    mirror.dispose();
  });

  it('projects readable text without leaking ANSI and OSC control sequences', async () => {
    const mirror = new TerminalMirror(40, 5, 100);
    mirror.write('\x1b]0;secret title\x07\x1b[31mfailed\x1b[0m\r\nnext');
    await mirror.fence(100, () => undefined);
    expect(mirror.plainText(100)).toContain('failed\nnext');
    expect(mirror.plainText(100)).not.toContain('\x1b');
    expect(mirror.plainText(100)).not.toContain('secret title');
    mirror.dispose();
  });

  it('captures the screen and parser tail inside the same queued boundary', async () => {
    const mirror = new TerminalMirror(20, 5, 100);
    const target = new xtermHeadless.Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    try {
      mirror.write('A\x1b[?100');
      const pending = mirror.snapshot(100, 1000);
      // xterm drains this in the same task after the fence callback, before
      // the Promise continuation executes. It must not enter the snapshot.
      mirror.write('6hB');
      const snapshot = await pending;
      expect(snapshot.parserTail).toBe('\x1b[?100');
      await write(target, snapshot.data + '\x1b[?2026l');
      applyXtermSnapshotState(target, snapshot.continuationState);
      await write(target, snapshot.parserTail + '6hB');
      expect(target.buffer.active.getLine(0)?.translateToString(true)).toBe('AB');
      expect(captureXtermSnapshotState(target).mouseEncoding).toBe('SGR');
      expect(snapshot.continuationState.mouseEncoding).toBe('DEFAULT');
    } finally { target.dispose(); mirror.dispose(); }
  });

  it.each([
    ['partial CSI mouse encoding', '\x1b[?1003hhello\x1b[?100', '6h!'],
    ['executed C0 inside partial CSI', 'hello\x1b[?100\r\n', '6h!'],
    ['executed C0 after CSI fast-path entry', 'hello\x1b[\r\n', '?1006h!'],
    ['ignored prefix after CSI fast-path C0', 'hello\x1b[\r\n?', '1006h!'],
    ['partial ESC charset designation', 'hello\x1b(', '0lqqk'],
    ['partial CSI truecolor', 'hello\x1b[38;2;1;', '2;3m!'],
    ['partial 8-bit CSI', 'hello\x9b?100', '6h!'],
    ['partial OSC', 'hello\x1b]0;incomplete', ' title\x07!'],
    ['OSC completed by ESC before ST', 'hello\x1b]0;title\x1b', '\\!'],
    ['OSC cancellation', 'hello\x1b]0;unfinished\x18prompt', '>'],
    ['partial DCS', 'hello\x1bP$q', 'm\x1b\\!'],
    ['partial APC', 'hello\x1b_Gincomplete', '\x1b\\!'],
    ['partial SOS', 'hello\x1bXignored', '\x1b\\!'],
    ['split surrogate', 'hello\ud83d', '\ude00!'],
    ['scroll region', '\x1b[2;5r\x1b[4;7Hstatus', '!'],
    ['origin-relative cursor', '\x1b[2;5r\x1b[?6h\x1b[3;4Hstatus', '!'],
    ['saved cursor', '\x1b[4;7H\x1b7\x1b[2;2Hstatus', '\x1b8!'],
    ['saved attributes and modes', '\x1b[2;5r\x1b[?6h\x1b[?7l\x1b[31;44;1m\x1b[3;7H\x1b7\x1b[?6l\x1b[?7h\x1b[0mstatus', '\x1b8!'],
    ['DEC charset', '\x1b(0lq', 'qk'],
    ['G1 charset and shift out', '\x1b)0\x0elq', 'qk\x0fabc'],
    ['saved charset before any designation', '\x1b7\x1b(0lq', '\x1b8qk'],
    ['saved G1 designation', '\x1b)0\x0e\x1b7\x1b)Babc', '\x1b8qk'],
    ['pending wrap', '12345678901234567890', '!'],
    ['pending wide-cell wrap', '123456789012345678界', '!'],
    ['saved pending wrap', '12345678901234567890\x1b7\x1b[2;1Hnext', '\x1b8!'],
    ['combining continuation', 'abc', '\u0301!'],
    ['standalone combining after SGR', 'a\x1b[31m\u0301b', '!'],
    ['leading standalone combining', '\u0301x', '!'],
    ['standalone combining across soft wraps', '\x1b[31m\u0301' + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(4), '!'],
    ['repeat preceding character', 'abc', '\x1b[3b!'],
    ['tab stops', '\x1b[3g\x1b[1;5H\x1bH\x1b[1;1Ha', '\t!'],
    ['extended current attributes', '\x1b[4:3;38;2;1;2;3mabc', '!'],
    ['alternate saved cursor', 'normal\x1b[?1049h\x1b[3;7H\x1b7\x1b[1;1Halt', '\x1b8!'],
    ['alternate default cells after changed current attrs', '\x1b[?1049halt\x1b[38;2;1;2;3m', '!'],
    ['normal cursor on alternate exit', '\x1b[3;7Hnormal\x1b[?1049halt', '\x1b[?1049l!'],
    ['independent buffer scroll regions', '\x1b[2;5r\x1b[4;7Hnormal\x1b[?1049h\x1b[1;4r\x1b[2;3Halt', '\x1b[?1049l!'],
    ['alternate saved empty charset array', '\x1b[?1049h\x1b7\x1b(0lq', '\x1b8qk'],
  ])('continues %s exactly after a real xterm snapshot', async (_name, prefix, suffix) => {
    const mirror = new TerminalMirror(20, 6, 100);
    const options = { cols: 20, rows: 6, scrollback: 100, scrollOnEraseInDisplay: true, allowProposedApi: true };
    const source = new xtermHeadless.Terminal(options);
    const target = new xtermHeadless.Terminal(options);
    try {
      mirror.write(prefix);
      await write(source, prefix);
      await restoredSnapshot(mirror, target);
      await Promise.all([write(source, suffix), write(target, suffix)]);
      expect(screen(target)).toEqual(screen(source));
      expect(captureXtermSnapshotState(target)).toEqual(captureXtermSnapshotState(source));
    } finally { source.dispose(); target.dispose(); mirror.dispose(); }
  });

  it('remaps saved cursor coordinates when the snapshot omits old scrollback', async () => {
    const mirror = new TerminalMirror(20, 6, 100);
    const source = new xtermHeadless.Terminal({ cols: 20, rows: 6, scrollback: 100, allowProposedApi: true });
    const target = new xtermHeadless.Terminal({ cols: 20, rows: 6, scrollback: 100, allowProposedApi: true });
    try {
      const prefix = Array.from({ length: 30 }, (_, index) => `line ${index}\r\n`).join('') + '\x1b[3;5H\x1b7\x1b[5;1Hlast';
      mirror.write(prefix);
      await write(source, prefix);
      await restoredSnapshot(mirror, target, 2);
      expect(target.buffer.normal.baseY).toBe(2);
      await Promise.all([write(source, '\x1b8!'), write(target, '\x1b8!')]);
      expect(screen(target)).toEqual(screen(source));
      expect(captureXtermSnapshotState(target).normal.savedYOffset).toBe(captureXtermSnapshotState(source).normal.savedYOffset);
    } finally { source.dispose(); target.dispose(); mirror.dispose(); }
  });

  it('keeps an omitted saved cursor at the viewport top when it is restored', async () => {
    const mirror = new TerminalMirror(20, 6, 100);
    const source = new xtermHeadless.Terminal({ cols: 20, rows: 6, scrollback: 100, allowProposedApi: true });
    const target = new xtermHeadless.Terminal({ cols: 20, rows: 6, scrollback: 100, allowProposedApi: true });
    try {
      const prefix = '\x1b[1;5H\x1b7' + Array.from({ length: 30 }, (_, index) => `line ${index}\r\n`).join('');
      mirror.write(prefix);
      await write(source, prefix);
      await restoredSnapshot(mirror, target, 0);
      await Promise.all([write(source, '\x1b8!'), write(target, '\x1b8!')]);
      expect(screen(target)).toEqual(screen(source));
      expect(target.buffer.active.cursorY).toBe(0);
    } finally { source.dispose(); target.dispose(); mirror.dispose(); }
  });

  it.each([0, 2, 100])('repairs standalone combining cells and wrapped history with %i scrollback rows', async (scrollback) => {
    const mirror = new TerminalMirror(4, 6, 100);
    const source = new xtermHeadless.Terminal({ cols: 4, rows: 6, scrollback: 100, allowProposedApi: true });
    const target = new xtermHeadless.Terminal({ cols: 4, rows: 6, scrollback: 100, allowProposedApi: true });
    try {
      const prefix = '\x1b[31m\u0301abcdefghijklmnopqrstuvwxyz0123456789';
      mirror.write(prefix);
      await write(source, prefix);
      await restoredSnapshot(mirror, target, scrollback);
      expect(target.buffer.normal.baseY).toBe(Math.min(scrollback, source.buffer.normal.baseY));
      expect(screen(target)).toEqual(screen(source));
      await Promise.all([write(source, '!'), write(target, '!')]);
      expect(screen(target)).toEqual(screen(source));
    } finally { source.dispose(); target.dispose(); mirror.dispose(); }
  });

  it('rejects capped snapshots without serializing a partially drained mirror', async () => {
    const mirror = new TerminalMirror(20, 5, 100);
    const internal = mirror as unknown as { terminal: Terminal };
    const stalledWrite = vi.spyOn(internal.terminal, 'write').mockImplementation(() => undefined);
    const serialize = vi.spyOn(mirror, 'serialize');
    try {
      await expect(mirror.snapshot(100, 1)).rejects.toThrow('timed out');
      expect(serialize).not.toHaveBeenCalled();
      // A late parser callback cannot turn a rejected boundary into success.
      const callback = stalledWrite.mock.calls[0]?.[1];
      callback?.();
      expect(serialize).not.toHaveBeenCalled();
    } finally { stalledWrite.mockRestore(); mirror.dispose(); }
  });

  it('rejects pending snapshots on disposal', async () => {
    const mirror = new TerminalMirror(20, 5, 100);
    const pending = mirror.snapshot(100, 1000);
    mirror.dispose();
    await expect(pending).rejects.toThrow('disposed');
  });

  it('refuses incompatible or mismatched continuation state', async () => {
    const mirror = new TerminalMirror(20, 5, 100);
    const target = new xtermHeadless.Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    try {
      const snapshot = await mirror.snapshot(100, 1000);
      expect(() => applyXtermSnapshotState(target, { ...snapshot.continuationState, cols: 21 })).toThrow('does not match');
      expect(() => applyXtermSnapshotState({}, snapshot.continuationState)).toThrow('Unsupported xterm');
    } finally { target.dispose(); mirror.dispose(); }
  });
});
