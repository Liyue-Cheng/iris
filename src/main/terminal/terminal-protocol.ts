import { terminalProtocolColors, type TerminalProtocolColors } from '@shared/terminal/terminal-palette';
import type { XtermColorEvent } from '@shared/terminal/xterm-color-events';

interface Disposable { dispose(): void }
export type TerminalColorsChanged = (listener: () => void) => Disposable;

/** The same parser owns display state and replies, even without a view. */
export interface TerminalProtocolPort {
  onData(listener: (data: string) => void): Disposable;
  onColor(listener: (event: XtermColorEvent) => void): Disposable;
  onColorSchemeQuery(listener: () => void): Disposable;
  readonly colorSchemeUpdates: boolean;
  registerSnapshotPrefix(provider: () => string): Disposable;
}

export class TerminalProtocol {
  private readonly disposables: Disposable[];
  private readonly overrides = new Map<number, string>();
  private base: string[] = [];
  private themeKey = '';

  constructor(
    private readonly terminal: TerminalProtocolPort,
    private readonly colors: () => TerminalProtocolColors,
    private readonly reply: (data: string) => void,
    onColorsChanged?: TerminalColorsChanged,
  ) {
    this.refreshTheme(false);
    // Consume xterm's parsed events: fragmentation, cancellation and color
    // syntax remain owned by its VT parser, with no second string scanner.
    this.disposables = [
      terminal.onData(reply),
      terminal.onColor((event) => this.handleColors(event)),
      terminal.onColorSchemeQuery(() => { this.refreshTheme(false); this.reportScheme(); }),
      terminal.registerSnapshotPrefix(() => this.snapshotColors()),
    ];
    if (onColorsChanged) this.disposables.push(onColorsChanged(() => this.refreshTheme(true)));
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private refreshTheme(notify: boolean): void {
    const palette = this.colors();
    const next = [
      ...(palette.ansi ?? terminalProtocolColors(undefined).ansi!),
      palette.foreground, palette.background, palette.cursor ?? palette.foreground,
    ];
    const key = next.join(';');
    if (key === this.themeKey) return;
    this.base = next;
    this.themeKey = key;
    // Browser ThemeService likewise replaces OSC overrides on theme change.
    this.overrides.clear();
    if (notify && this.terminal.colorSchemeUpdates) this.reportScheme();
  }

  private value(index: number): string { return this.overrides.get(index) ?? this.base[index]!; }

  private handleColors(event: XtermColorEvent): void {
    this.refreshTheme(false);
    for (const request of event) {
      if (request.type === 0) {
        this.reply(oscColor(request.index, this.value(request.index)));
      } else {
        if (request.type === 1) {
          this.overrides.set(request.index, `#${request.color.map((v) => v.toString(16).padStart(2, '0')).join('')}`);
        } else if (request.index === undefined) {
          for (const index of this.overrides.keys()) if (index < 256) this.overrides.delete(index);
        } else {
          this.overrides.delete(request.index);
        }
        if (this.terminal.colorSchemeUpdates) this.reportScheme();
      }
    }
  }

  private reportScheme(): void {
    const mode = luminance(this.value(257)) < luminance(this.value(256)) ? 1 : 2;
    this.reply(`\x1b[?997;${mode}n`);
  }

  private snapshotColors(): string {
    this.refreshTheme(false);
    // A retained browser may contain overrides from a later/older view. Reset
    // first, then restore this checkpoint's palette before painting its cells.
    let data = '\x1b]104\x1b\\\x1b]110\x1b\\\x1b]111\x1b\\\x1b]112\x1b\\';
    for (const [index, value] of this.overrides) data += oscColor(index, value);
    return data;
  }
}

function oscColor(index: number, hex: string): string {
  const ident = index < 256 ? `4;${index}` : String(index - 246);
  return `\x1b]${ident};${toOscRgb(hex)}\x1b\\`;
}

function toOscRgb(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`invalid terminal protocol color: ${hex}`);
  return `rgb:${match[1]}${match[1]}/${match[2]}${match[2]}/${match[3]}${match[3]}`;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
