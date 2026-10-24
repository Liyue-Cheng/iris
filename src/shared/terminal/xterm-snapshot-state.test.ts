// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import xtermHeadless from '@xterm/headless';
import { TerminalMirror } from '../../main/terminal/terminal-mirror';
import { applyXtermSnapshotState, captureXtermSnapshotState } from './xterm-snapshot-state';

// Exercise the real browser parser without claiming to exercise its renderer.
vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => null });
});

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

describe('xterm snapshot compatibility between headless and browser', () => {
  it.each([
    ['mouse and partial CSI', '\x1b[?1003hhello\x1b[?100', '6h!'],
    ['origin and scroll region', '\x1b[2;5r\x1b[?6h\x1b[3;4Hstatus', '!'],
    ['saved cursor and attrs', '\x1b[31;44;1m\x1b[4;7H\x1b7\x1b[0m\x1b[2;2Hstatus', '\x1b8!'],
    ['sparse G3 designation', '\x1b+0\x1bo\x1b7lq\x1b+B', '\x1b8qk'],
    ['pending wrap', '12345678901234567890', '!'],
    ['standalone combining and soft wraps', '\x1b[31m\u0301' + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(4), '!'],
    ['alternate and normal registers', '\x1b[3;7Hnormal\x1b[?1049h\x1b[2;3H\x1b7alt', '\x1b8!\x1b[?1049l?'],
    ['alternate default cells after changed current attrs', '\x1b[?1049halt\x1b[38;2;1;2;3m', '!'],
    ['hyperlink continuation', '\x1b]8;id=test;https://example.com\x1b\\abc', '!'],
  ])('restores %s into the installed browser xterm', async (_name, prefix, suffix) => {
    const mirror = new TerminalMirror(20, 6, 100);
    const terminal = new Terminal({ cols: 20, rows: 6, allowProposedApi: true });
    const source = new xtermHeadless.Terminal({ cols: 20, rows: 6, allowProposedApi: true });
    try {
      mirror.write(prefix);
      await new Promise<void>((resolve) => source.write(prefix, resolve));
      const snapshot = await mirror.snapshot(100, 1000);
      await write(terminal, snapshot.data + '\x1b[?2026l');
      applyXtermSnapshotState(terminal, structuredClone(snapshot.continuationState));
      await write(terminal, snapshot.parserTail + suffix);
      await new Promise<void>((resolve) => source.write(suffix, resolve));
      mirror.write(suffix);
      const continued = await mirror.snapshot(100, 1000);
      expect(captureXtermSnapshotState(terminal)).toEqual(continued.continuationState);
      for (let row = 0; row < terminal.rows; row++) {
        const actual = terminal.buffer.active.getLine(terminal.buffer.active.baseY + row)!;
        const expected = source.buffer.active.getLine(source.buffer.active.baseY + row)!;
        for (let col = 0; col < terminal.cols; col++) {
          const a = actual.getCell(col)!;
          const e = expected.getCell(col)!;
          expect([a.getChars(), a.getWidth(), a.getFgColor(), a.getBgColor()]).toEqual(
            [e.getChars(), e.getWidth(), e.getFgColor(), e.getBgColor()],
          );
        }
      }
    } finally { terminal.dispose(); source.dispose(); mirror.dispose(); }
  });
});
