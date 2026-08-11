/**
 * Renderer-side clipboard — the single entry point for copy/paste. Never
 * use navigator.clipboard directly: in the Electron file:// context its
 * read/write needs web Permission API grants and rejects silently
 * (Marina 勘误第二轮). The IPC bridge to Electron's clipboard module has
 * no permission layer. Failures are converted into visible, deduplicated
 * notifications so callers may safely use these helpers from event handlers.
 */
import { CHANNELS } from '@shared/protocol';
import { attemptAction } from './action-runtime';
import { notify } from '@renderer/stores/notification-store';
import { translate } from '@renderer/i18n';

function reportClipboardFailure(kind: 'read' | 'write', message: string): void {
  notify({
    dedupeKey: `clipboard:${kind}`,
    title: translate(kind === 'read' ? 'errors.clipboardReadFailed' : 'errors.clipboardWriteFailed'),
    message,
    domain: 'clipboard',
  });
}

export async function writeClipboardText(text: string): Promise<boolean> {
  const outcome = await attemptAction(() =>
    window.api.invoke<{ text: string }, { ok: boolean }>(
      CHANNELS.CLIPBOARD_WRITE_TEXT,
      { text },
    ),
  );
  if (outcome.status === 'ok') return outcome.value.ok;
  if (outcome.status === 'failed') reportClipboardFailure('write', outcome.error.message);
  return false;
}

export async function readClipboardText(): Promise<string | null> {
  const outcome = await attemptAction(() =>
    window.api.invoke<undefined, { text: string }>(
      CHANNELS.CLIPBOARD_READ_TEXT,
    ),
  );
  if (outcome.status === 'ok') return outcome.value.text;
  if (outcome.status === 'failed') reportClipboardFailure('read', outcome.error.message);
  return null;
}
