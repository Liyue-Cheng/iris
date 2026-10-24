/**
 * Tracks only uncommitted parser input, using the installed xterm VT table.
 * It is advanced synchronously at enqueue time, independently of xterm's drain.
 * Already executed C0 controls must not be replayed inside an unfinished CSI.
 */
export class TerminalParserTail {
  private state = 0;
  private tail = '';
  private surrogate = '';
  private overflow = false;

  constructor(private readonly transitions: Uint16Array, private readonly maxTail = 1024 * 1024) {}

  write(data: string): void {
    // InputHandler splits long strings before decoding/parsing. Keep those
    // boundaries: the current xterm CSI fast path depends on lookahead.
    for (let index = 0; index < data.length; index += 131072) this.writeChunk(data.slice(index, index + 131072));
  }

  private writeChunk(data: string): void {
    if (!data) return;
    const decoded: number[] = [];
    let start = 0;
    if (this.surrogate) {
      const first = data.charCodeAt(0);
      const high = this.surrogate.charCodeAt(0);
      this.surrogate = '';
      if (first >= 0xdc00 && first <= 0xdfff) {
        decoded.push((high - 0xd800) * 0x400 + first - 0xdc00 + 0x10000);
      } else {
        decoded.push(high, first);
      }
      start = 1;
    }
    for (let index = start; index < data.length; index++) {
      const code = data.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (++index === data.length) {
          this.surrogate = String.fromCharCode(code);
          break;
        }
        const low = data.charCodeAt(index);
        if (low >= 0xdc00 && low <= 0xdfff) decoded.push((code - 0xd800) * 0x400 + low - 0xdc00 + 0x10000);
        else decoded.push(code, low);
      } else if (code !== 0xfeff) {
        decoded.push(code);
      }
    }
    for (let index = 0; index < decoded.length; index++) {
      const code = decoded[index]!;
      if (code === 0x1b && this.state < 8 && index + 2 < decoded.length && decoded[index + 1] === 0x5b) {
        this.state = 4;
        this.overflow = false;
        const prefix = decoded[index + 2]!;
        if (prefix >= 0x3c && prefix <= 0x3f) {
          this.tail = '\x1b[' + String.fromCodePoint(prefix);
          index += 2;
        } else {
          // xterm's fast path enters CSI_PARAM even with no digits. A zero
          // preserves that state after executed C0 bytes are removed; replay
          // of a bare ESC [ would instead enter CSI_ENTRY and accept a later ?.
          this.tail = '\x1b[0';
          index++;
        }
        continue;
      }
      this.consume(code);
    }
  }

  private consume(code: number): void {
    const transition = this.transitions[(this.state << 8) | Math.min(code, 0xa0)];
    if (transition === undefined) throw new Error('Unsupported terminal parser transition');
    const action = transition >>> 8;
    let next = transition & 255;
    // OSC_END, DCS_UNHOOK and APC_END treat ESC as the next introducer.
    if (code === 0x1b && (action === 6 || action === 14 || action === 17)) next = 1;
    if (next === 0) {
      this.tail = '';
      this.overflow = false;
    } else if (code === 0x1b || (code >= 0x80 && code <= 0x9f)) {
      this.tail = String.fromCodePoint(code);
      this.overflow = false;
    } else if (action !== 3 && !this.overflow) {
      this.tail += String.fromCodePoint(code);
      if (this.tail.length > this.maxTail) {
        this.tail = '';
        this.overflow = true;
      }
    }
    this.state = next;
  }

  capture(): { data: string; state: number } {
    if (this.overflow) throw new Error('Terminal control sequence exceeds the safe snapshot tail limit');
    return { data: this.tail + this.surrogate, state: this.state };
  }
}
