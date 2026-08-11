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
});
