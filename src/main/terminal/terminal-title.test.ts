import { describe, expect, it } from 'vitest';
import { looksLikeShellStartupGarbage, sanitizeTerminalTitle } from './terminal-title';

describe('terminal title policy', () => {
  it('removes controls and bidi overrides, collapses whitespace and caps length', () => {
    expect(sanitizeTerminalTitle('  vim\x00\u202e  task.md  ')).toBe('vim task.md');
    expect(sanitizeTerminalTitle('x'.repeat(120))).toHaveLength(100);
  });

  it('separates shell startup titles from useful application titles', () => {
    expect(looksLikeShellStartupGarbage('C:\\Windows\\pwsh.exe')).toBe(true);
    expect(looksLikeShellStartupGarbage('MINGW64:/work/iris')).toBe(true);
    expect(looksLikeShellStartupGarbage('vim C:\\work\\task.md')).toBe(false);
  });
});
