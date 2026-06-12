/**
 * @file src/shared/ime-textarea-workaround.ts
 * @purpose IME-1 workaround (ported from Marina, same xterm 6.1.0-beta.256) —
 *   attach a compositionend listener on xterm's helper-textarea that clears
 *   textarea.value after a short delay, killing the "Chinese IME punctuation
 *   flushes a wall of stale history into the PTY" bug at its root.
 *
 * Root cause lives in @xterm/xterm's CompositionHelper: it only clears the
 * textarea on Enter (CR) or Ctrl+C (ETX). A Chinese-IME user who doesn't
 * press Enter for a while accumulates hundreds of characters; several race
 * paths (nested finalize, keydown-229 replace diff, _dataAlreadySent skew)
 * then read substring(start..end) over that backlog and ship it to onData.
 * Clearing after every compositionend removes the backlog all those paths
 * depend on.
 *
 * The delay must run AFTER xterm's own setTimeout(0) substring read — 0ms
 * would swallow the current input too. 16ms (~one frame) is Marina's
 * battle-tested value.
 *
 * Duck-typed + injectable timers so the logic stays unit-testable without
 * a DOM. Returns a detach fn for unmount cleanup.
 */

export interface ImeTextareaLike {
  value: string;
  addEventListener(type: 'compositionend', listener: () => void): void;
  removeEventListener(type: 'compositionend', listener: () => void): void;
}

type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface AttachOptions {
  /** Delay before clearing; must outlast xterm's setTimeout(0) read. */
  delayMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => TimeoutHandle;
  clearTimeoutFn?: (handle: TimeoutHandle) => void;
}

/**
 * Attach the compositionend cleaner. Rapid successive compositionends
 * coalesce: a new event cancels the previous pending clear.
 */
export function attachImeCompositionEndCleaner(
  textarea: ImeTextareaLike,
  options: AttachOptions = {},
): () => void {
  const delayMs = options.delayMs ?? 16;
  const setT = options.setTimeoutFn ?? setTimeout;
  const clearT = options.clearTimeoutFn ?? clearTimeout;

  let pending: TimeoutHandle | null = null;

  const listener = (): void => {
    if (pending !== null) {
      clearT(pending);
    }
    pending = setT(() => {
      pending = null;
      textarea.value = '';
    }, delayMs);
  };

  textarea.addEventListener('compositionend', listener);

  return () => {
    textarea.removeEventListener('compositionend', listener);
    if (pending !== null) {
      clearT(pending);
      pending = null;
    }
  };
}
