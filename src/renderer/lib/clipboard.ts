/**
 * Renderer-side clipboard — the single entry point for copy/paste. Never
 * use navigator.clipboard directly: in the Electron file:// context its
 * read/write needs web Permission API grants and rejects silently
 * (Marina 勘误第二轮). The IPC bridge to Electron's clipboard module has
 * no permission layer. All failures are swallowed: write returns false,
 * read returns ''.
 */
import { CHANNELS } from '@shared/protocol';

export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    const res = await window.api.invoke<{ text: string }, { ok: boolean }>(
      CHANNELS.CLIPBOARD_WRITE_TEXT,
      { text },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function readClipboardText(): Promise<string> {
  try {
    const res = await window.api.invoke<undefined, { text: string }>(
      CHANNELS.CLIPBOARD_READ_TEXT,
    );
    return res.text;
  } catch {
    return '';
  }
}
