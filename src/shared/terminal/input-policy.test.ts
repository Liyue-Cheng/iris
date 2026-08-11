import { describe, expect, it } from 'vitest';
import { droppedPathPlan, isTerminalFocusReport, pasteConfirmationPlan } from './input-policy';

describe('terminal input policy', () => {
  it('returns confirmations in the current large, escape, multiline order', () => {
    expect(
      pasteConfirmationPlan(`a\x1b[2J\n${'x'.repeat(20)}`, {
        bracketedPasteMode: false,
        largePasteBytes: 10,
      }),
    ).toEqual([
      { kind: 'large', bytes: 26 },
      { kind: 'escape' },
      { kind: 'multiline', lines: 2 },
    ]);
  });

  it('does not warn for multiline text when bracketed paste is enabled', () => {
    expect(pasteConfirmationPlan('one\ntwo\n', { bracketedPasteMode: true })).toEqual([]);
  });

  it('classifies shell metacharacters and quotes whitespace paths', () => {
    expect(droppedPathPlan(['plain.txt', 'two words.md', 'unsafe;name.txt'])).toEqual({
      dangerousPaths: ['unsafe;name.txt'],
      text: 'plain.txt "two words.md" unsafe;name.txt',
    });
  });

  it('separates focus protocol reports from user input', () => {
    expect(isTerminalFocusReport('\x1b[I')).toBe(true);
    expect(isTerminalFocusReport('\x1b[O')).toBe(true);
    expect(isTerminalFocusReport('\x1b[A')).toBe(false);
    expect(isTerminalFocusReport('x')).toBe(false);
  });
});
