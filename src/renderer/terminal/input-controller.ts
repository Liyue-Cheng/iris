import { droppedPathPlan, pasteConfirmationPlan, type PasteConfirmation } from '@shared/terminal/input-policy';
import { ShellPathQuotingError, type ShellPathRejection, type TerminalShellKind } from '@shared/terminal/shell-quoting';
import { TerminalSessionRuntime } from './terminal-runtime';

export interface TerminalInputPort {
  bracketedPasteMode(): boolean;
  paste(text: string): void;
  focus(): void;
  sendInput(text: string): Promise<void>;
  readClipboard(): Promise<string | null>;
  readDocument(docPath: string): Promise<string>;
  confirm(request: PasteConfirmation): Promise<boolean>;
  docDropMode(): 'path' | 'content';
  shellKind(): TerminalShellKind;
  rejectPath(reason: ShellPathRejection): void;
}

export class TerminalInputController {
  constructor(
    private readonly runtime: TerminalSessionRuntime,
    private readonly port: TerminalInputPort,
  ) {}

  async pasteClipboard(): Promise<void> {
    const epoch = this.runtime.captureInput();
    if (!this.runtime.acceptsInput(epoch)) return;
    const text = await this.port.readClipboard();
    if (!this.runtime.acceptsInput(epoch) || text === null) return;
    await this.pasteText(text, epoch);
  }

  async pasteText(text: string, operationEpoch = this.runtime.captureInput()): Promise<void> {
    if (!text || !this.runtime.acceptsInput(operationEpoch)) return;
    try {
      const confirmations = pasteConfirmationPlan(text, {
        bracketedPasteMode: this.port.bracketedPasteMode(),
      });
      for (const confirmation of confirmations) {
        const accepted = await this.port.confirm(confirmation);
        if (!accepted || !this.runtime.acceptsInput(operationEpoch)) return;
      }
      this.port.paste(text);
    } finally {
      if (this.runtime.acceptsInput(operationEpoch)) this.port.focus();
    }
  }

  async dropPaths(paths: readonly string[]): Promise<void> {
    const epoch = this.runtime.captureInput();
    if (paths.length === 0 || !this.runtime.acceptsInput(epoch)) return;
    let text: string;
    try {
      text = droppedPathPlan(paths, this.port.shellKind()).text;
    } catch (error) {
      if (!(error instanceof ShellPathQuotingError)) throw error;
      this.port.rejectPath(error.reason);
      return;
    }
    await this.port.sendInput(text);
    if (this.runtime.acceptsInput(epoch)) this.port.focus();
  }

  async dropDocument(docPath: string): Promise<void> {
    const epoch = this.runtime.captureInput();
    if (!this.runtime.acceptsInput(epoch)) return;
    if (this.port.docDropMode() === 'path') {
      await this.dropPaths([docPath]);
      return;
    }
    const text = await this.port.readDocument(docPath);
    if (!this.runtime.acceptsInput(epoch)) return;
    await this.pasteText(text, epoch);
  }
}
