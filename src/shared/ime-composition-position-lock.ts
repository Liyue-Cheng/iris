/**
 * @file src/shared/ime-composition-position-lock.ts
 * @purpose IME-2 workaround (ported from Marina, same xterm 6.1.0-beta.256) —
 *   monkey-patch `_core._compositionHelper.updateCompositionElements` so the
 *   helper-textarea / candidate window stays pinned to the buffer.x/y
 *   snapshot taken at compositionstart instead of chasing every transient
 *   cursor move a TUI makes (Claude Code / vim insert mode repeatedly
 *   save→move→draw→restore the cursor, which xterm otherwise treats as
 *   "where the textarea belongs right now" — the IME candidate box jitters).
 *
 * Mechanism: while composing, swap bufferService.buffer.x/y to the snapshot,
 * call the original implementation, then restore in a finally. Swapping the
 * buffer fields (rather than re-deriving geometry) means every derived
 * position inside xterm uses the locked values. Detach restores the original
 * method only if our patch is still installed.
 *
 * Uses xterm's private `_core` shape — attach sites must feature-detect and
 * degrade gracefully (default xterm behavior: jittering candidates, still
 * functional).
 */

/** Minimal slice of xterm's BufferService.buffer — plain fields, writable. */
export interface BufferLike {
  x: number;
  y: number;
}

/** Minimal slice of IBufferService — `.buffer` must be a stable reference. */
export interface BufferServiceLike {
  buffer: BufferLike;
}

/** Minimal slice of ICompositionHelper — the method we patch. */
export interface CompositionHelperLike {
  updateCompositionElements(skipRecurse?: boolean): void;
}

export interface CompositionTextareaLike {
  addEventListener(type: 'compositionstart' | 'compositionend', listener: () => void): void;
  removeEventListener(type: 'compositionstart' | 'compositionend', listener: () => void): void;
}

/**
 * Attach the position lock. Outside composition the patch forwards to the
 * original untouched; detach fully restores xterm default behavior.
 */
export function attachImeCompositionPositionLock(
  textarea: CompositionTextareaLike,
  compositionHelper: CompositionHelperLike,
  bufferService: BufferServiceLike,
): () => void {
  let locked: { x: number; y: number } | null = null;

  const onStart = (): void => {
    locked = { x: bufferService.buffer.x, y: bufferService.buffer.y };
  };
  const onEnd = (): void => {
    locked = null;
  };

  textarea.addEventListener('compositionstart', onStart);
  textarea.addEventListener('compositionend', onEnd);

  // Keep the unbound original for detach-time identity comparison; invoke
  // via .call(helper) so `this` stays correct.
  const origUpdate = compositionHelper.updateCompositionElements;

  const patchedUpdate = function (skipRecurse?: boolean): void {
    if (!locked) {
      origUpdate.call(compositionHelper, skipRecurse);
      return;
    }
    const buf = bufferService.buffer;
    const realX = buf.x;
    const realY = buf.y;
    buf.x = locked.x;
    buf.y = locked.y;
    try {
      origUpdate.call(compositionHelper, skipRecurse);
    } finally {
      buf.x = realX;
      buf.y = realY;
    }
  };

  compositionHelper.updateCompositionElements = patchedUpdate;

  return (): void => {
    textarea.removeEventListener('compositionstart', onStart);
    textarea.removeEventListener('compositionend', onEnd);
    if (compositionHelper.updateCompositionElements === patchedUpdate) {
      compositionHelper.updateCompositionElements = origUpdate;
    }
    locked = null;
  };
}
