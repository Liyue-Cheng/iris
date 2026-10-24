import type { ThemeId } from '../types';
import type { TerminalBaseColors } from './terminal-colors';
import { getXtermTheme } from './xterm-themes';

export interface TerminalProtocolColors extends TerminalBaseColors {
  cursor?: string;
  ansi?: readonly string[];
}

const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

const extendedAnsi = (): string[] => {
  const values: string[] = [];
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  for (const r of [0, 95, 135, 175, 215, 255]) {
    for (const g of [0, 95, 135, 175, 215, 255]) {
      for (const b of [0, 95, 135, 175, 215, 255]) values.push(`#${hex(r)}${hex(g)}${hex(b)}`);
    }
  }
  for (let i = 0; i < 24; i++) values.push(`#${hex(8 + i * 10).repeat(3)}`);
  return values;
};
const DEFAULT_EXTENDED_ANSI = extendedAnsi();

export function terminalProtocolColors(themeId: ThemeId | undefined): TerminalProtocolColors {
  const theme = getXtermTheme(themeId);
  return {
    foreground: theme.foreground, background: theme.background, cursor: theme.cursor,
    ansi: [...ANSI_KEYS.map((key) => theme[key]), ...(theme.extendedAnsi ?? DEFAULT_EXTENDED_ANSI)],
  };
}
