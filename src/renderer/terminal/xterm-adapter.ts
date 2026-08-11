import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { ThemeId } from '@shared/types';
import {
  getXtermTheme,
  isLightTheme,
  LIGHT_THEME_MIN_CONTRAST,
} from '@renderer/theme/xterm-themes';

// Keep the old frame painted while a full-state snapshot replaces both buffers.
// This resets every mode SerializeAddon can restore without using RIS/DECSTR,
// because either reset would also turn synchronized output off mid-transaction.
const SYNCHRONIZED_REPLAY_BEGIN = [
  '\x1b[?2026h',
  '\x1b[?1049l',
  '\x1b[?1l',
  '\x1b[?66l',
  '\x1b[?2004l',
  '\x1b[4l',
  '\x1b[?6l',
  '\x1b[?45l',
  '\x1b[?1004l',
  '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l',
  '\x1b[?1005l\x1b[?1006l\x1b[?1015l',
  '\x1b[?7h\x1b[?25h',
  '\x1b[r\x1b[0m\x1b(B',
  '\x1b[2J\x1b[3J\x1b[H',
].join('');

const SYNCHRONIZED_REPLAY_END = '\x1b[?2026l';

export interface BrowserXtermOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  themeId: ThemeId | undefined;
  renderer: 'auto' | 'webgl' | 'dom';
  windowsBuild: number | null;
  openLink(event: MouseEvent, uri: string): void;
}

export class BrowserXtermAdapter {
  readonly terminal: Terminal;
  readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  private webgl: WebglAddon | null = null;

  constructor(private readonly options: BrowserXtermOptions) {
    this.terminal = new Terminal({
      scrollback: 5000,
      scrollOnEraseInDisplay: true,
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      lineHeight: options.lineHeight,
      theme: getXtermTheme(options.themeId),
      minimumContrastRatio: isLightTheme(options.themeId) ? LIGHT_THEME_MIN_CONTRAST : 1,
      scrollbar: { width: 10 },
      linkHandler: { activate: options.openLink },
      allowProposedApi: true,
      ...(options.windowsBuild
        ? { windowsPty: { backend: 'conpty' as const, buildNumber: options.windowsBuild } }
        : {}),
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.loadAddon(new WebLinksAddon(options.openLink));
    this.terminal.loadAddon(this.search);
  }

  open(host: HTMLElement): void {
    this.terminal.open(host);
    if (this.options.renderer === 'dom') return;
    try {
      this.webgl = new WebglAddon();
      this.webgl.onContextLoss(() => {
        try {
          this.webgl?.dispose();
        } catch {
          // DOM fallback remains usable.
        }
        this.webgl = null;
      });
      this.terminal.loadAddon(this.webgl);
    } catch {
      this.webgl = null;
    }
  }

  updateAppearance(options: {
    themeId: ThemeId;
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
  }): void {
    this.terminal.options.theme = getXtermTheme(options.themeId);
    this.terminal.options.minimumContrastRatio = isLightTheme(options.themeId)
      ? LIGHT_THEME_MIN_CONTRAST
      : 1;
    this.terminal.options.fontFamily = options.fontFamily;
    this.terminal.options.fontSize = options.fontSize;
    this.terminal.options.lineHeight = options.lineHeight;
  }

  beginSynchronizedReplay(): void {
    this.terminal.write(SYNCHRONIZED_REPLAY_BEGIN);
  }

  endSynchronizedReplay(callback?: () => void): void {
    this.terminal.write(SYNCHRONIZED_REPLAY_END, callback);
  }

  dispose(): void {
    try {
      this.webgl?.dispose();
    } catch {
      // Continue terminal disposal.
    }
    this.webgl = null;
    this.terminal.dispose();
  }
}

export type BrowserTerminal = Terminal;
