import { describe, expect, it } from 'vitest';
import { TerminalMirror } from './terminal-mirror';
import { TerminalProtocol } from './terminal-protocol';
import { terminalProtocolColors } from '@shared/terminal/terminal-palette';

async function flush(mirror: TerminalMirror): Promise<void> {
  await mirror.fence(1000, () => { throw new Error('parser did not drain'); });
}

describe('TerminalProtocol', () => {
  it('owns indexed colors, program overrides, resets and color-scheme notifications', async () => {
    const mirror = new TerminalMirror(80, 24, 100);
    let palette = terminalProtocolColors('saas-dark');
    let changed!: () => void;
    const replies: string[] = [];
    const protocol = new TerminalProtocol(mirror, () => palette, (data) => replies.push(data),
      (listener) => { changed = listener; return { dispose() {} }; });
    try {
      mirror.write('\x1b]4;1;?;232;?\x07\x1b]12;?\x07\x1b[?996n');
      await flush(mirror);
      expect(replies).toEqual([
        '\x1b]4;1;rgb:f8f8/7171/7171\x1b\\',
        '\x1b]4;232;rgb:0808/0808/0808\x1b\\',
        '\x1b]12;rgb:6060/a5a5/fafa\x1b\\', '\x1b[?997;1n',
      ]);
      mirror.write('\x1b]4;1;rgb:12/34/56\x07\x1b]11;#ffffff\x07\x1b]4;1;?\x07\x1b[?996n');
      await flush(mirror);
      expect(replies.slice(-2)).toEqual(['\x1b]4;1;rgb:1212/3434/5656\x1b\\', '\x1b[?997;2n']);
      const snapshot = await mirror.snapshot(100, 1000);
      expect(snapshot.data).toContain('\x1b]4;1;rgb:1212/3434/5656\x1b\\');
      expect(snapshot.data).toContain('\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
      mirror.write('\x1b]104;1\x07\x1b]111\x07\x1b]4;1;?\x07\x1b[?996n\x1b[?2031h');
      await flush(mirror);
      expect(replies.slice(-2)).toEqual(['\x1b]4;1;rgb:f8f8/7171/7171\x1b\\', '\x1b[?997;1n']);
      palette = terminalProtocolColors('saas-light');
      changed();
      expect(replies.at(-1)).toBe('\x1b[?997;2n');
      mirror.write('\x1b]4;255;?\x07');
      await flush(mirror);
      expect(replies.at(-1)).toBe('\x1b]4;255;rgb:6464/6464/6464\x1b\\');
      mirror.write('\x1b[?2031l');
      await flush(mirror);
      const count = replies.length;
      palette = terminalProtocolColors('saas-dark');
      changed();
      expect(replies).toHaveLength(count);
    } finally { protocol.dispose(); mirror.dispose(); }
  });

  it('answers fragmented queries once, without a renderer, using the current theme', async () => {
    const mirror = new TerminalMirror(80, 24, 100);
    let colors = { foreground: '#a1b2c3', background: '#102030' };
    const replies: string[] = [];
    const protocol = new TerminalProtocol(mirror, () => colors, (data) => replies.push(data));
    try {
      for (const part of ['hello\x1b[', '6n\x1b]', '10;?', '\x07\x1b]11;?\x1b', '\\']) mirror.write(part);
      await flush(mirror);
      expect(replies).toEqual(['\x1b[1;6R', '\x1b]10;rgb:a1a1/b2b2/c3c3\x1b\\', '\x1b]11;rgb:1010/2020/3030\x1b\\']);
      colors = { foreground: '#010203', background: '#ffffff' };
      mirror.write('\x1b]10;?;?\x07');
      await flush(mirror);
      expect(replies.slice(-2)).toEqual(['\x1b]10;rgb:0101/0202/0303\x1b\\', '\x1b]11;rgb:ffff/ffff/ffff\x1b\\']);
      expect(mirror.plainText(100)).toBe('hello');
    } finally { protocol.dispose(); mirror.dispose(); }
  });

  it.each(['\x18', '\x1a', '\x1b[2J'])('releases screen output after canceled OSC (%j)', async (cancel) => {
    const mirror = new TerminalMirror(80, 24, 100);
    const replies: string[] = [];
    const protocol = new TerminalProtocol(mirror, () => ({ foreground: '#ffffff', background: '#000000' }), (data) => replies.push(data));
    try {
      mirror.write('\x1b]0;unfinished');
      mirror.write(`${cancel}\x1b[Hprompt> `);
      await flush(mirror);
      expect(mirror.plainText(100)).toBe('prompt> ');
      expect(replies).toEqual([]);
    } finally { protocol.dispose(); mirror.dispose(); }
  });

  it('keeps title parsing and unsubscribes every reply source on disposal', async () => {
    const mirror = new TerminalMirror(80, 24, 100);
    const titles: string[] = [], replies: string[] = [];
    mirror.onTitleChange((title) => titles.push(title));
    const protocol = new TerminalProtocol(mirror, () => ({ foreground: '#ffffff', background: '#000000' }), (data) => replies.push(data));
    try {
      mirror.write('x\x1b]0;title\x07y\x1b[c\x1b[?1006$p');
      await flush(mirror);
      expect(titles).toEqual(['title']);
      expect(mirror.plainText(100)).toBe('xy');
      expect(replies).toEqual(['\x1b[?1;2c', '\x1b[?1006;2$y']);
      protocol.dispose();
      mirror.write('\x1b[6n\x1b]10;?\x07');
      await flush(mirror);
      expect(replies).toHaveLength(2);
    } finally { mirror.dispose(); }
  });
});
