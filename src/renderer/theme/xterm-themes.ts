/**
 * @file src/renderer/theme/xterm-themes.ts
 * @purpose xterm.js theme colors for all Marina palettes. Ported verbatim from
 *   Marina's TerminalView (incl. the BETA-035 light-theme contrast fixes and
 *   the light extended-ANSI table).
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
 * light-theme backgrounds. (Marina BETA-035.)
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
  cutie: {
    background: '#fff8fb',
    foreground: '#5c1d3e',
    cursor: '#e91e63',
    cursorAccent: '#fff8fb',
    selectionBackground: '#f5c3d3',
    scrollbarSliderBackground: '#f5c3d3',
    scrollbarSliderHoverBackground: '#e8a3bd',
    scrollbarSliderActiveBackground: '#a8627e',
    overviewRulerBorder: '#fff8fb',
    black: '#5c1d3e',
    red: '#c81258',
    green: '#4d8a5e',
    yellow: '#b8682e',
    blue: '#7665b8',
    magenta: '#b8347e',
    cyan: '#4d7d9e',
    white: '#5c1d3e',
    brightBlack: '#8a4566',
    brightRed: '#a8124a',
    brightGreen: '#3a6b48',
    brightYellow: '#8f4f1c',
    brightBlue: '#5a4b96',
    brightMagenta: '#9c2868',
    brightCyan: '#3a6480',
    brightWhite: '#3d0f28',
    extendedAnsi: LIGHT_EXTENDED_ANSI,
  },
  business: {
    background: '#1d2733',
    foreground: '#d8dee9',
    cursor: '#88c0d0',
    cursorAccent: '#1d2733',
    selectionBackground: '#3b4252',
    scrollbarSliderBackground: '#3b4252',
    scrollbarSliderHoverBackground: '#4c566a',
    scrollbarSliderActiveBackground: '#6c7a8c',
    overviewRulerBorder: '#1d2733',
    black: '#2e3440',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#d8dee9',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  ubuntu: {
    background: '#300a24',
    foreground: '#eeeeec',
    cursor: '#dd4814',
    cursorAccent: '#300a24',
    selectionBackground: '#5e2750',
    scrollbarSliderBackground: '#5e2750',
    scrollbarSliderHoverBackground: '#77376b',
    scrollbarSliderActiveBackground: '#876783',
    overviewRulerBorder: '#300a24',
    black: '#2e3436',
    red: '#cc0000',
    green: '#4e9a06',
    yellow: '#c4a000',
    blue: '#3465a4',
    magenta: '#75507b',
    cyan: '#06989a',
    white: '#d3d7cf',
    brightBlack: '#555753',
    brightRed: '#ef2929',
    brightGreen: '#8ae234',
    brightYellow: '#fce94f',
    brightBlue: '#729fcf',
    brightMagenta: '#ad7fa8',
    brightCyan: '#34e2e2',
    brightWhite: '#eeeeec',
  },
  'windows-terminal': {
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#cccccc',
    cursorAccent: '#0c0c0c',
    selectionBackground: '#3a3d41',
    scrollbarSliderBackground: '#3a3d41',
    scrollbarSliderHoverBackground: '#505357',
    scrollbarSliderActiveBackground: '#767676',
    overviewRulerBorder: '#0c0c0c',
    black: '#0c0c0c',
    red: '#c50f1f',
    green: '#13a10e',
    yellow: '#c19c00',
    blue: '#0037da',
    magenta: '#881798',
    cyan: '#3a96dd',
    white: '#cccccc',
    brightBlack: '#767676',
    brightRed: '#e74856',
    brightGreen: '#16c60c',
    brightYellow: '#f9f1a5',
    brightBlue: '#3b78ff',
    brightMagenta: '#b4009e',
    brightCyan: '#61d6d6',
    brightWhite: '#f2f2f2',
  },
  'one-dark-pro': {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selectionBackground: '#3e4451',
    scrollbarSliderBackground: '#3e4451',
    scrollbarSliderHoverBackground: '#545862',
    scrollbarSliderActiveBackground: '#5c6370',
    overviewRulerBorder: '#282c34',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  dracula: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    scrollbarSliderBackground: '#44475a',
    scrollbarSliderHoverBackground: '#565a73',
    scrollbarSliderActiveBackground: '#6272a4',
    overviewRulerBorder: '#282a36',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  'tokyo-night': {
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    cursorAccent: '#1a1b26',
    selectionBackground: '#283457',
    scrollbarSliderBackground: '#2f334d',
    scrollbarSliderHoverBackground: '#414868',
    scrollbarSliderActiveBackground: '#565f89',
    overviewRulerBorder: '#1a1b26',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
  'catppuccin-mocha': {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#585b70',
    scrollbarSliderBackground: '#45475a',
    scrollbarSliderHoverBackground: '#585b70',
    scrollbarSliderActiveBackground: '#7f849c',
    overviewRulerBorder: '#1e1e2e',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
  'catppuccin-latte': {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#dc8a78',
    cursorAccent: '#eff1f5',
    selectionBackground: '#acb0be',
    scrollbarSliderBackground: '#bcc0cc',
    scrollbarSliderHoverBackground: '#acb0be',
    scrollbarSliderActiveBackground: '#6c6f85',
    overviewRulerBorder: '#eff1f5',
    black: '#5c5f77',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#ea76cb',
    cyan: '#179299',
    white: '#acb0be',
    brightBlack: '#5e5d6e',
    brightRed: '#d20f39',
    brightGreen: '#40a02b',
    brightYellow: '#a36e10',
    brightBlue: '#1e66f5',
    brightMagenta: '#8839ef',
    brightCyan: '#0a7176',
    brightWhite: '#4c4f69',
    extendedAnsi: LIGHT_EXTENDED_ANSI,
  },
  'tokyo-night-day': {
    background: '#e1e2e7',
    foreground: '#3760bf',
    cursor: '#3760bf',
    cursorAccent: '#e1e2e7',
    selectionBackground: '#b6bdcf',
    scrollbarSliderBackground: '#b6bdcf',
    scrollbarSliderHoverBackground: '#a8adc0',
    scrollbarSliderActiveBackground: '#555f8c',
    overviewRulerBorder: '#e1e2e7',
    black: '#a1a6c5',
    red: '#f52a65',
    green: '#587539',
    yellow: '#8c6c3e',
    blue: '#2e7de9',
    magenta: '#9854f1',
    cyan: '#007197',
    white: '#6172b0',
    brightBlack: '#4f5d9e',
    brightRed: '#f52a65',
    brightGreen: '#587539',
    brightYellow: '#8c6c3e',
    brightBlue: '#2e7de9',
    brightMagenta: '#9854f1',
    brightCyan: '#007197',
    brightWhite: '#3760bf',
    extendedAnsi: LIGHT_EXTENDED_ANSI,
  },
  'light-pink': {
    background: '#f5f5f5',
    foreground: '#54494b',
    cursor: '#ff7ab3',
    cursorAccent: '#f5f5f5',
    selectionBackground: '#f1dde9',
    scrollbarSliderBackground: '#f1dde9',
    scrollbarSliderHoverBackground: '#ffb8ca',
    scrollbarSliderActiveBackground: '#7d6770',
    overviewRulerBorder: '#f5f5f5',
    black: '#54494b',
    red: '#d2304b',
    green: '#4a7559',
    yellow: '#8a6c1f',
    blue: '#1f6e89',
    magenta: '#9d3c5e',
    cyan: '#2d6b75',
    white: '#54494b',
    brightBlack: '#7d6770',
    brightRed: '#d2304b',
    brightGreen: '#4a7559',
    brightYellow: '#8a6c1f',
    brightBlue: '#1f6e89',
    brightMagenta: '#8855a0',
    brightCyan: '#2d6b75',
    brightWhite: '#44132d',
    extendedAnsi: LIGHT_EXTENDED_ANSI,
  },
  fairyfloss: {
    background: '#5a5475',
    foreground: '#f8f8f2',
    cursor: '#c5a3ff',
    cursorAccent: '#5a5475',
    selectionBackground: '#6959aa',
    scrollbarSliderBackground: '#6959aa',
    scrollbarSliderHoverBackground: '#716799',
    scrollbarSliderActiveBackground: '#a186cf',
    overviewRulerBorder: '#5a5475',
    black: '#5a5475',
    red: '#ff857f',
    green: '#c2ffdf',
    yellow: '#ffea00',
    blue: '#c5a3ff',
    magenta: '#ffb8d1',
    cyan: '#c2ffdf',
    white: '#f8f8f2',
    brightBlack: '#a186cf',
    brightRed: '#ff857f',
    brightGreen: '#c2ffdf',
    brightYellow: '#fff352',
    brightBlue: '#9673d3',
    brightMagenta: '#ffb8d1',
    brightCyan: '#c2ffdf',
    brightWhite: '#ffffff',
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
