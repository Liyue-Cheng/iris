import type { ThemeId } from '@shared/types';

export interface TerminalBaseColors {
  foreground: string;
  background: string;
}

export const TERMINAL_BASE_COLORS: Record<ThemeId, TerminalBaseColors> = {
  'rose-pine': { foreground: '#e0def4', background: '#191724' },
  'rose-pine-dawn': { foreground: '#575279', background: '#faf4ed' },
  'rose-pine-moon': { foreground: '#e0def4', background: '#232136' },
  cutie: { foreground: '#5c1d3e', background: '#fff8fb' },
  business: { foreground: '#d8dee9', background: '#1d2733' },
  ubuntu: { foreground: '#eeeeec', background: '#300a24' },
  'windows-terminal': { foreground: '#cccccc', background: '#0c0c0c' },
  'one-dark-pro': { foreground: '#abb2bf', background: '#282c34' },
  dracula: { foreground: '#f8f8f2', background: '#282a36' },
  'tokyo-night': { foreground: '#c0caf5', background: '#1a1b26' },
  'catppuccin-mocha': { foreground: '#cdd6f4', background: '#1e1e2e' },
  'catppuccin-latte': { foreground: '#4c4f69', background: '#eff1f5' },
  'tokyo-night-day': { foreground: '#3760bf', background: '#e1e2e7' },
  'light-pink': { foreground: '#54494b', background: '#f5f5f5' },
  fairyfloss: { foreground: '#f8f8f2', background: '#5a5475' },
};

export function terminalBaseColors(theme: ThemeId | undefined): TerminalBaseColors {
  return TERMINAL_BASE_COLORS[theme ?? 'rose-pine'] ?? TERMINAL_BASE_COLORS['rose-pine'];
}
