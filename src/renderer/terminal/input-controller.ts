import { droppedPathPlan, pasteConfirmationPlan, type PasteConfirmation } from '@shared/terminal/input-policy';
import { TerminalSessionRuntime } from './terminal-runtime';

export interface TerminalInputPort {
  bracketedPasteMode(): boolean;
  paste(text: string): void;
  focus(): void;
  sendInput(text: string): Promise<void>;
  readClipboard(): Promise<string | null>;
  readDocument(docPath: string): Promise<string>;
  confirm(request: PasteConfirmation | { kind: 'shell-meta'; paths: string[] }): Promise<boolean>;
  docDropMode(): 'path' | 'content';
}

export class TerminalInputController {
  constructor(
    private readonly runtime: TerminalSessionRuntime,
    private readonly port: TerminalInputPort,
  ) {}

  async pasteClipboard(): Promise<void> {
    const epoch = this.runtime.capture();
    const text = await this.port.readClipboard();
    if (!this.runtime.isCurrent(epoch) || text === null) return;
    await this.pasteText(text, epoch);
  }

  async pasteText(text: string, operationEpoch = this.runtime.capture()): Promise<void> {
    if (!text || !this.runtime.isCurrent(operationEpoch)) return;
    try {
      const confirmations = pasteConfirmationPlan(text, {
        bracketedPasteMode: this.port.bracketedPasteMode(),
      });
      for (const confirmation of confirmations) {
        const accepted = await this.port.confirm(confirmation);
        if (!accepted || !this.runtime.isCurrent(operationEpoch)) return;
      }
      this.port.paste(text);
    } finally {
      if (this.runtime.isCurrent(operationEpoch)) this.port.focus();
    }
  }

  async dropPaths(paths: readonly string[]): Promise<void> {
    const epoch = this.runtime.capture();
    if (paths.length === 0 || !this.runtime.isCurrent(epoch)) return;
    const plan = droppedPathPlan(paths);
    if (plan.dangerousPaths.length > 0) {
      const accepted = await this.port.confirm({ kind: 'shell-meta', paths: plan.dangerousPaths });
      if (!accepted || !this.runtime.isCurrent(epoch)) return;
    }
    await this.port.sendInput(plan.text);
    if (this.runtime.isCurrent(epoch)) this.port.focus();
  }

  async dropDocument(docPath: string): Promise<void> {
    const epoch = this.runtime.capture();
    if (this.port.docDropMode() === 'path') {
      await this.dropPaths([docPath]);
      return;
    }
    const text = await this.port.readDocument(docPath);
    if (!this.runtime.isCurrent(epoch)) return;
    await this.pasteText(text, epoch);
  }
}
