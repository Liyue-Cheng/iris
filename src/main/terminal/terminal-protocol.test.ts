import { describe, expect, it } from 'vitest';
import { TerminalProtocol } from './terminal-protocol';

describe('TerminalProtocol', () => {
  const colors = () => ({ foreground: '#a1b2c3', background: '#102030' });

  it('answers and consumes OSC 10/11 queries across arbitrary chunk boundaries', () => {
    const protocol = new TerminalProtocol(colors);
    expect(protocol.consume('before\x1b')).toEqual({ display: 'before', replies: [] });
    expect(protocol.consume(']10;')).toEqual({ display: '', replies: [] });
    expect(protocol.consume('?\x07middle\x1b]11;?\x1b')).toEqual({
      display: 'middle',
      replies: ['\x1b]10;rgb:a1a1/b2b2/c3c3\x07'],
    });
    expect(protocol.consume('\\after')).toEqual({
      display: 'after',
      replies: ['\x1b]11;rgb:1010/2020/3030\x1b\\'],
    });
  });

  it('passes unrelated OSC sequences through byte-for-byte', () => {
    const protocol = new TerminalProtocol(colors);
    expect(protocol.consume('x\x1b]0;title\x07y')).toEqual({
      display: 'x\x1b]0;title\x07y',
      replies: [],
    });
  });

  it('bounds malformed unterminated OSC buffering', () => {
    const protocol = new TerminalProtocol(colors);
    const malformed = `\x1b]0;${'x'.repeat(5000)}`;
    expect(protocol.consume(malformed).display).toBe(malformed);
    expect(protocol.reset()).toBe('');
  });
});
