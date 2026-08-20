import { describe, expect, it } from 'vitest';
import { TerminalMirror } from './terminal-mirror';

describe('TerminalMirror', () => {
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
