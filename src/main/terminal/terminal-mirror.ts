import type { IDisposable } from 'node-pty';
import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';

const { Terminal: HeadlessTerminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;

export type TerminalBufferType = 'normal' | 'alternate';

export class TerminalMirror {
  private readonly terminal: InstanceType<typeof HeadlessTerminal>;
  private readonly serializer: InstanceType<typeof SerializeAddon>;
  private disposed = false;
  private pendingBytes = 0;

  constructor(
    cols: number,
    rows: number,
    scrollback: number,
    private readonly flow?: {
      highBytes: number;
      lowBytes: number;
      setBlocked(blocked: boolean): void;
    },
  ) {
    this.terminal = new HeadlessTerminal({
      cols,
      rows,
      scrollback,
      scrollOnEraseInDisplay: true,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
  }

  get rows(): number {
    return this.terminal.rows;
  }

  get activeBufferType(): TerminalBufferType {
    return this.terminal.buffer.active.type;
  }

  onTitleChange(listener: (title: string) => void): IDisposable {
    return this.terminal.onTitleChange(listener);
  }

  write(data: string): void {
    if (this.disposed) return;
    const bytes = Buffer.byteLength(data, 'utf8');
    this.pendingBytes += bytes;
    if (this.flow && this.pendingBytes >= this.flow.highBytes) this.flow.setBlocked(true);
    this.terminal.write(data, () => {
      this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
      if (this.flow && this.pendingBytes <= this.flow.lowBytes) this.flow.setBlocked(false);
    });
  }

  resize(cols: number, rows: number): void {
    if (!this.disposed) this.terminal.resize(cols, rows);
  }

  fence(capMs: number, onCapped: () => void): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (capped: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (capped) onCapped();
        resolve();
      };
      timer = setTimeout(() => done(true), capMs);
      this.terminal.write(new Uint8Array(0), () => done(false));
    });
  }

  serialize(scrollback: number): string {
    let ansi = this.serializer.serialize({ scrollback });
    const core = (
      this.terminal as unknown as {
        _core?: {
          coreService?: { isCursorHidden?: boolean };
          buffer?: { scrollTop?: number; scrollBottom?: number };
        };
      }
    )._core;
    if (core?.coreService?.isCursorHidden) ansi += '\x1b[?25l';
    const top = core?.buffer?.scrollTop;
    const bottom = core?.buffer?.scrollBottom;
    if (
      typeof top === 'number' &&
      typeof bottom === 'number' &&
      (top !== 0 || bottom !== this.terminal.rows - 1)
    ) {
      ansi += `\x1b[${top + 1};${bottom + 1}r`;
    }
    return ansi;
  }

  plainText(scrollback: number): string {
    const buffer = this.terminal.buffer.active;
    const start = Math.max(0, buffer.length - Math.max(this.terminal.rows, scrollback));
    const lines: string[] = [];
    for (let index = start; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingBytes = 0;
    this.flow?.setBlocked(false);
    this.terminal.dispose();
  }

  get diagnostics(): { pendingBytes: number } {
    return { pendingBytes: this.pendingBytes };
  }
}
