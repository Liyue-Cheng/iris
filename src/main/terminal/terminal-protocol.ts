import type { TerminalBaseColors } from '@shared/terminal/terminal-colors';

const OSC_START = '\x1b]';
const BEL = '\x07';
const ST = '\x1b\\';
const MAX_PENDING_OSC_CHARS = 4096;

export interface TerminalProtocolResult {
  display: string;
  replies: string[];
}

export class TerminalProtocol {
  private pending = '';

  constructor(private readonly colors: () => TerminalBaseColors) {}

  consume(chunk: string): TerminalProtocolResult {
    this.pending += chunk;
    let display = '';
    const replies: string[] = [];

    while (this.pending) {
      const start = this.pending.indexOf(OSC_START);
      if (start < 0) {
        if (this.pending.endsWith('\x1b')) {
          display += this.pending.slice(0, -1);
          this.pending = '\x1b';
        } else {
          display += this.pending;
          this.pending = '';
        }
        break;
      }
      display += this.pending.slice(0, start);
      this.pending = this.pending.slice(start);

      const bel = this.pending.indexOf(BEL, OSC_START.length);
      const st = this.pending.indexOf(ST, OSC_START.length);
      const terminatorIndex = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
      if (terminatorIndex < 0) {
        if (this.pending.length > MAX_PENDING_OSC_CHARS) {
          display += this.pending;
          this.pending = '';
        }
        break;
      }

      const terminator = terminatorIndex === bel ? BEL : ST;
      const end = terminatorIndex + terminator.length;
      const sequence = this.pending.slice(0, end);
      const content = this.pending.slice(OSC_START.length, terminatorIndex);
      this.pending = this.pending.slice(end);
      const reply = this.replyFor(content, terminator);
      if (reply) replies.push(reply);
      else display += sequence;
    }

    return { display, replies };
  }

  reset(): string {
    const pending = this.pending;
    this.pending = '';
    return pending;
  }

  private replyFor(content: string, terminator: string): string | null {
    const colors = this.colors();
    if (content === '10;?') return `${OSC_START}10;${toOscRgb(colors.foreground)}${terminator}`;
    if (content === '11;?') return `${OSC_START}11;${toOscRgb(colors.background)}${terminator}`;
    return null;
  }
}

function toOscRgb(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`invalid terminal protocol color: ${hex}`);
  return `rgb:${match[1]}${match[1]}/${match[2]}${match[2]}/${match[3]}${match[3]}`;
}
