import type { TFunction } from 'i18next';
import { composeDocPasteBlock } from '@renderer/lib/doc-drag';
import { readClipboardText } from '@renderer/lib/clipboard';
import { confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { getSettings } from '@renderer/stores/settings-store';
import { notify } from '@renderer/stores/notification-store';
import { rendererI18n } from '@renderer/i18n';
import type { ShellPathRejection, TerminalShellKind } from '@shared/terminal/shell-quoting';
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
  getShellKind?(): TerminalShellKind;
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
      }
    },
    docDropMode: () => getSettings()?.behavior.terminalDocDrop ?? 'content',
    shellKind: () => options.getShellKind?.() ?? 'unknown',
    rejectPath: (reason) => {
      const chinese = (rendererI18n.resolvedLanguage ?? rendererI18n.language ?? '').startsWith('zh');
      notify({
        dedupeKey: `terminal:path-drop:${runtime.sessionId}`,
        title: options.getTranslate()('errors.terminalDropFailed'),
        message: PATH_REJECTION_MESSAGES[reason][chinese ? 'zh' : 'en'],
        domain: 'shell',
      });
    },
  });
}

const PATH_REJECTION_MESSAGES: Record<ShellPathRejection, { zh: string; en: string }> = {
  'unknown-shell': {
    zh: '无法确认此终端的启动 Shell，未发送路径。请使用 PowerShell、cmd 或受支持的 POSIX Shell 新建终端。',
    en: 'The launch shell is unknown, so no paths were sent. Open a new terminal with PowerShell, cmd or a supported POSIX shell.',
  },
  'control-character': {
    zh: '路径含换行或终端控制字符，未发送路径。请重命名后重试。',
    en: 'The path contains a line break or terminal control character. No paths were sent. Rename it and try again.',
  },
  'cmd-expansion': {
    zh: 'cmd 无法保证含 %、! 或双引号的路径保持原样，未发送路径。请使用 PowerShell 终端。',
    en: 'cmd cannot reliably preserve paths containing %, ! or double quotes. No paths were sent. Use a PowerShell terminal.',
  },
};
