import { describe, expect, it } from 'vitest';
import { TERMINAL_BASE_COLORS } from '@shared/terminal/terminal-colors';
import { getXtermTheme } from '@renderer/theme/xterm-themes';

describe('terminal protocol colors', () => {
  it('stay aligned with every browser xterm theme', () => {
    for (const [themeId, colors] of Object.entries(TERMINAL_BASE_COLORS)) {
      const theme = getXtermTheme(themeId as keyof typeof TERMINAL_BASE_COLORS);
      expect({ foreground: theme.foreground, background: theme.background }).toEqual(colors);
    }
  });
});
