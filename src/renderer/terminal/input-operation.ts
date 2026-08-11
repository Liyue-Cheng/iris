import type { TFunction } from 'i18next';
import { composeDocPasteBlock } from '@renderer/lib/doc-drag';
import { readClipboardText } from '@renderer/lib/clipboard';
import { confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { getSettings } from '@renderer/stores/settings-store';
import { TerminalInputController } from './input-controller';
import type { TerminalSessionRuntime } from './terminal-runtime';
import type { TerminalTransport } from './terminal-transport';

export function createTerminalInputController(options: {
  runtime: TerminalSessionRuntime;
  transport: TerminalTransport;
  terminal: {
    readonly modes: { bracketedPasteMode: boolean };
    paste(text: string): void;
    focus(): void;
  };
  getTranslate(): TFunction;
}): TerminalInputController {
  const { runtime, transport, terminal } = options;
  return new TerminalInputController(runtime, {
    bracketedPasteMode: () => terminal.modes.bracketedPasteMode,
    paste: (text) => terminal.paste(text),
    focus: () => terminal.focus(),
    sendInput: (text) => transport.sendInput(text),
    readClipboard: readClipboardText,
    readDocument: async (docPath) => composeDocPasteBlock(await transport.readDocument(docPath)),
    confirm: (request) => {
      const translate = options.getTranslate();
      switch (request.kind) {
        case 'large':
          return confirmDialog({
            title: translate('terminal.largePasteTitle'),
            message: translate('terminal.largePasteMessage', {
              mb: (request.bytes / 1024 / 1024).toFixed(2),
            }),
            confirmText: translate('terminal.continuePaste'),
          });
        case 'escape':
          return confirmDialog({
            title: translate('terminal.escTitle'),
            message: translate('terminal.escMessage'),
            confirmText: translate('terminal.pasteAnyway'),
            tone: 'destructive',
          });
        case 'multiline':
          return confirmDialog({
            title: translate('terminal.multilineTitle'),
            message: translate('terminal.multilineMessage', { count: request.lines }),
            confirmText: translate('terminal.continuePaste'),
            tone: 'destructive',
          });
        case 'shell-meta':
          return confirmDialog({
            title: translate('terminal.shellMetaTitle'),
            message: translate('terminal.shellMetaMessage', { paths: request.paths.join('\n') }),
            confirmText: translate('terminal.pasteAnyway'),
            tone: 'destructive',
          });
      }
    },
    docDropMode: () => getSettings()?.behavior.terminalDocDrop ?? 'content',
  });
}
