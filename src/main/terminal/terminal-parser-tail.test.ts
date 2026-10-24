import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import { TerminalParserTail } from './terminal-parser-tail';
import { xtermParserState, xtermTransitionTable } from '../../shared/terminal/xterm-snapshot-state';

describe('TerminalParserTail', () => {
  it.each([
    'plain\x1b[?100\r\n6h!',
    'plain\x1b[?100\x18prompt',
    'plain\x1b[1:2;;3$invalid',
    'plain\x1b]0;title\x1b\\!',
    'plain\x1b]0;title\x18prompt',
    'plain\x1bP1;2$q\x08text\x1b\\!',
    'plain\x1b_Ghello\x09\x1b\\!',
    'plain\x1bXignored\x1b\\!',
    'plain\x9b?1006h\x9d0;title\x9c!',
    'plain\x1b(0lq\x1b(Btext',
    'plain\ud83d\ude00\u0301text',
    'plain\x1b[1\ufeff;2H!',
  ])('matches real xterm for every split in %j', async (stream) => {
    const terminal = new xtermHeadless.Terminal({ cols: 20, rows: 6, allowProposedApi: true });
    const tracker = new TerminalParserTail(xtermTransitionTable(terminal));
    try {
      for (const codeUnit of stream.split('')) {
        tracker.write(codeUnit);
        await new Promise<void>((resolve) => terminal.write(codeUnit, resolve));
        expect(tracker.capture().state).toBe(xtermParserState(terminal));
      }
      expect(tracker.capture().data).toBe('');
    } finally { terminal.dispose(); }
  });

  it('bounds retained input and rejects snapshots until an overlong control sequence ends', () => {
    const terminal = new xtermHeadless.Terminal();
    const tracker = new TerminalParserTail(xtermTransitionTable(terminal), 20);
    try {
      tracker.write('\x1b]0;' + 'x'.repeat(100));
      expect(() => tracker.capture()).toThrow('safe snapshot tail limit');
      tracker.write('\x07prompt>');
      expect(tracker.capture()).toEqual({ data: '', state: 0 });
      tracker.write('\x1b[?100\r\n');
      expect(tracker.capture().data).toBe('\x1b[?100');
    } finally { terminal.dispose(); }
  });
});
