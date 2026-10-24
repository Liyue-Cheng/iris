import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import { TerminalMirror } from './terminal-mirror';

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
});
