import type { IDisposable } from 'node-pty';
import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';
import {
  captureXtermSnapshotState,
  xtermParserState,
  xtermSnapshotAnsiSuffix,
  xtermTransitionTable,
  type XtermSnapshotState,
} from '../../shared/terminal/xterm-snapshot-state';
import { TerminalParserTail } from './terminal-parser-tail';
import { xtermColorCore, type XtermColorEvent } from '../../shared/terminal/xterm-color-events';

const { Terminal: HeadlessTerminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;

export type TerminalBufferType = 'normal' | 'alternate';

export class TerminalMirror {
  private readonly terminal: InstanceType<typeof HeadlessTerminal>;
  private readonly serializer: InstanceType<typeof SerializeAddon>;
  private disposed = false;
  private pendingBytes = 0;
  private readonly parserTail: TerminalParserTail;
  private readonly pendingSnapshots = new Set<(error: Error) => void>();
  private readonly snapshotPrefixes = new Set<() => string>();

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
    this.parserTail = new TerminalParserTail(xtermTransitionTable(this.terminal));
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

  onData(listener: (data: string) => void): IDisposable {
    return this.terminal.onData(listener);
  }

  registerOscHandler(identifier: number, handler: (data: string) => boolean): IDisposable {
    return this.terminal.parser.registerOscHandler(identifier, handler);
  }

  onColor(listener: (event: XtermColorEvent) => void): IDisposable {
    return xtermColorCore(this.terminal)._inputHandler.onColor(listener);
  }

  onColorSchemeQuery(listener: () => void): IDisposable {
    return xtermColorCore(this.terminal)._inputHandler.onRequestColorSchemeQuery(listener);
  }

  get colorSchemeUpdates(): boolean {
    return xtermColorCore(this.terminal).coreService.decPrivateModes.colorSchemeUpdates;
  }

  registerSnapshotPrefix(provider: () => string): IDisposable {
    this.snapshotPrefixes.add(provider);
    return { dispose: () => { this.snapshotPrefixes.delete(provider); } };
  }

  write(data: string): void {
    if (this.disposed) return;
    this.parserTail.write(data);
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
    // Each addon buffer serializer assumes default initial attributes, but its
    // normal-buffer trailer restores the current attributes before entering
    // alternate. Reset at that boundary so those attributes cannot tint the
    // alternate screen's default cells.
    const screen = this.serializer.serialize({ scrollback }).replace(
      '\x1b[?1049h\x1b[H', '\x1b[?1049h\x1b[H\x1b[0m',
    );
    return screen + xtermSnapshotAnsiSuffix(this.terminal);
  }

  snapshot(scrollback: number, capMs: number): Promise<{
    data: string;
    parserTail: string;
    continuationState: XtermSnapshotState;
  }> {
    return new Promise((resolve, reject) => {
      if (this.disposed) { reject(new Error('Terminal mirror is disposed')); return; }
      const tail = this.parserTail.capture();
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingSnapshots.delete(fail);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('Terminal snapshot parsing timed out')), capMs);
      this.pendingSnapshots.add(fail);
      this.terminal.write(new Uint8Array(0), () => {
        if (settled) return;
        try {
          if (xtermParserState(this.terminal) !== tail.state) throw new Error('Terminal snapshot parser state mismatch');
          // Serialize inside the parser callback: resolving a fence first lets
          // xterm drain later chunks before the awaiting microtask can run.
          const data = [...this.snapshotPrefixes].map((provider) => provider()).join('') + this.serialize(scrollback);
          const continuationState = captureXtermSnapshotState(this.terminal, scrollback);
          settled = true;
          clearTimeout(timer);
          this.pendingSnapshots.delete(fail);
          resolve({ data, parserTail: tail.data, continuationState });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
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
    for (const fail of this.pendingSnapshots) fail(new Error('Terminal mirror is disposed'));
    this.pendingBytes = 0;
    this.flow?.setBlocked(false);
    this.terminal.dispose();
  }

  get diagnostics(): { pendingBytes: number } {
    return { pendingBytes: this.pendingBytes };
  }
}
