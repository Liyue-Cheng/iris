/**
 * @file src/renderer/theme/xterm-themes.ts
 * @purpose xterm.js theme colors for the three Rose Pine variants. Ported
 *   verbatim from Marina's TerminalView (incl. the BETA-035 Dawn bright-ANSI
 *   contrast fixes and the light extended-ANSI table).
 *
 * xterm does not consume CSS variables — these objects must stay aligned by
 * hand with the [data-theme] palettes in styles/global.css.
 *
 * Consumed from M3 (session layer). The XtermTheme type is structurally
 * compatible with @xterm/xterm's ITheme; swap to the real import when the
 * dependency lands in M3.
 */
import type { ThemeId } from '@shared/types';

export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  /** xterm 6.x custom scrollbar (vscode-style ScrollableElement) — keep in
   *  sync with the global ::-webkit-scrollbar rules: slider = highlight-med,
   *  hover = highlight-high, active = muted. */
  scrollbarSliderBackground: string;
  scrollbarSliderHoverBackground: string;
  scrollbarSliderActiveBackground: string;
  /** 1px outline the overview ruler always paints (enabled as a side effect
   *  of setting scrollbar.width) — match background to keep it invisible. */
  overviewRulerBorder: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  /** Override table for ANSI 16-255 (light themes need darker grays). */
  extendedAnsi?: string[];
}

/**
 * Light-theme extended ANSI (16-255): keep the standard 6×6×6 cube, compress
 * the 232-255 gray ramp from slope 10 to slope 4 so all grays stay ≥4.5:1 on
 * Rose Pine Dawn's #faf4ed background. (Marina BETA-035.)
 */
function buildLightExtendedAnsi(): string[] {
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const rgb = (r: number, g: number, b: number): string => `#${hex(r)}${hex(g)}${hex(b)}`;
  const cube = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  const out: string[] = [];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        out.push(rgb(cube[r]!, cube[g]!, cube[b]!));
      }
    }
  }
  for (let n = 232; n <= 255; n++) {
    const v = 8 + (n - 232) * 4;
    out.push(rgb(v, v, v));
  }
  return out;
}

export const LIGHT_EXTENDED_ANSI = buildLightExtendedAnsi();

export const XTERM_THEMES: Record<ThemeId, XtermTheme> = {
  'rose-pine': {
    background: '#191724',
    foreground: '#e0def4',
    cursor: '#e0def4',
    cursorAccent: '#191724',
    selectionBackground: '#403d52',
    scrollbarSliderBackground: '#403d52',
    scrollbarSliderHoverBackground: '#524f67',
    scrollbarSliderActiveBackground: '#6e6a86',
    overviewRulerBorder: '#191724',
    black: '#26233a',
    red: '#eb6f92',
    green: '#31748f',
    yellow: '#f6c177',
    blue: '#9ccfd8',
    magenta: '#c4a7e7',
    cyan: '#ebbcba',
    white: '#e0def4',
    brightBlack: '#6e6a86',
    brightRed: '#eb6f92',
    brightGreen: '#31748f',
    brightYellow: '#f6c177',
    brightBlue: '#9ccfd8',
    brightMagenta: '#c4a7e7',
    brightCyan: '#ebbcba',
    brightWhite: '#e0def4',
  },
  'rose-pine-dawn': {
    // Marina BETA-035: bright ANSI tuned to WCAG AA (≥4.5:1) on the light
    // base — brightBlack #5e5a73 (~6:1), brightYellow #a36e10 (~5:1),
    // brightCyan #a35a55 (~5:1); other brights = normal (Dawn's own design).
    background: '#faf4ed',
    foreground: '#575279',
    cursor: '#575279',
    cursorAccent: '#faf4ed',
    selectionBackground: '#dfdad9',
    scrollbarSliderBackground: '#dfdad9',
    scrollbarSliderHoverBackground: '#cecacd',
    scrollbarSliderActiveBackground: '#6b6680',
    overviewRulerBorder: '#faf4ed',
    black: '#f2e9e1',
    red: '#b4637a',
    green: '#286983',
    yellow: '#ea9d34',
    blue: '#56949f',
    magenta: '#907aa9',
    cyan: '#d7827e',
    white: '#575279',
    brightBlack: '#5e5a73',
    brightRed: '#b4637a',
    brightGreen: '#286983',
    brightYellow: '#a36e10',
    brightBlue: '#56949f',
    brightMagenta: '#907aa9',
    brightCyan: '#a35a55',
    brightWhite: '#575279',
    extendedAnsi: LIGHT_EXTENDED_ANSI,
  },
  'rose-pine-moon': {
    background: '#232136',
    foreground: '#e0def4',
    cursor: '#e0def4',
    cursorAccent: '#232136',
    selectionBackground: '#44415a',
    scrollbarSliderBackground: '#44415a',
    scrollbarSliderHoverBackground: '#56526e',
    scrollbarSliderActiveBackground: '#6e6a86',
    overviewRulerBorder: '#232136',
    black: '#393552',
    red: '#eb6f92',
    green: '#3e8fb0',
    yellow: '#f6c177',
    blue: '#9ccfd8',
    magenta: '#c4a7e7',
    cyan: '#ea9a97',
    white: '#e0def4',
    brightBlack: '#6e6a86',
    brightRed: '#eb6f92',
    brightGreen: '#3e8fb0',
    brightYellow: '#f6c177',
    brightBlue: '#9ccfd8',
    brightMagenta: '#c4a7e7',
    brightCyan: '#ea9a97',
    brightWhite: '#e0def4',
  },
};

export function getXtermTheme(themeId: ThemeId | undefined): XtermTheme {
  return XTERM_THEMES[themeId ?? 'rose-pine'] ?? XTERM_THEMES['rose-pine'];
}

/**
 * Whether a theme is light — decided by reference-equality on the shared
 * LIGHT_EXTENDED_ANSI table (a theme that filled it in is light). Paired with
 * xterm's minimumContrastRatio, this turns the WCAG-AA contrast floor ON only
 * for light themes, so dim text (Claude Code's `\x1b[38;5;245m` hints, git diff
 * context lines) stays readable on a pale background without flattening the
 * deliberately-muted colors dark themes rely on. (Marina BETA-035.)
 */
export function isLightTheme(themeId: ThemeId | undefined): boolean {
  return getXtermTheme(themeId).extendedAnsi === LIGHT_EXTENDED_ANSI;
}

/** WCAG AA floor applied in light themes only. */
export const LIGHT_THEME_MIN_CONTRAST = 4.5;
