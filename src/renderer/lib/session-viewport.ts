import type { SessionKey } from './session-projection';

export type SessionViewportMode = 'follow-bottom' | 'free';

export interface SessionViewportState {
  mode: SessionViewportMode;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export const VIEWPORT_BOTTOM_ENTER_PX = 24;
export const VIEWPORT_BOTTOM_EXIT_PX = 32;

/** How long after the last user gesture the interaction gate stays open. The
 * browser keeps emitting scroll events (wheel inertia, scrollbar settle) for
 * a few frames after the finger/wheel stops; attributing those to the same
 * gesture — not to an anonymous scroll — is what lets a programmatic write
 * never be misread as user intent. */
const INTERACTION_RESET_MS = 120;

/** Keys that scroll the viewport. A keydown for anything else (Enter, typing
 * a prompt, etc.) must not open the interaction gate, or it would briefly
 * suppress the follow bottom-anchor for no reason. */
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

const memory = new Map<SessionKey, SessionViewportState>();

function metrics(viewport: HTMLElement): Pick<SessionViewportState, 'scrollHeight' | 'clientHeight'> {
  return {
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
  };
}

function distanceFromBottom(viewport: HTMLElement): number {
  return Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
}

function maxScrollTop(viewport: HTMLElement): number {
  return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
}

function frameRequest(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(() => callback(Date.now()), 0) as unknown as number;
}

function frameCancel(frame: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  else clearTimeout(frame);
}

/**
 * Owns the scroll semantics for a mounted Session surface.
 *
 * Two invariants make "streaming + rapid switching" stable, where the former
 * threshold-and-absolute-pixel model was not:
 *
 * 1. **Intent is declared by the user, never inferred from position.** A
 *    `scroll` event alone only captures current metrics; it cannot change
 *    `mode`. `mode` flips only while the interaction gate is open — a real
 *    wheel / touch / pointer-drag / scroll-key gesture just happened. Any
 *    scroll produced by our own writes (bottom anchor, restore, resize
 *    compensation) therefore never re-classifies intent, which kills the
 *    self-triggering loop that "streaming growth momentarily >32px from the
 *    bottom → misread as 'user scrolled up'" caused.
 * 2. **A frozen view anchors its top edge (scrollTop), not an absolute
 *    pixel goal.** With `overflow-anchor: none` on the container, content
 *    appended at the bottom leaves scrollTop untouched, so the reader's
 *    position is stable no matter how fast tokens stream below. The old
 *    absolute-`scrollTop` memory decayed the instant content grew; a bottom
 *    offset would instead push the reader up. (Content growing *above* the
 *    frozen viewport is the one shape neither numeric anchor survives; that
 *    needs DOM-node anchoring and is out of scope here.)
 *
 * Switch is one transaction: dispose cancels pending work and invalidates
 * late callbacks so nothing writes into a replaced Session; restore runs in
 * the layout effect before first paint, clamping a freeze position into the
 * current range and deferring the un-restorable remainder until content
 * returns. A `follow-bottom` session restores to bottom unconditionally —
 * whatever transient scrollTop was captured mid-stream is irrelevant.
 */
export class SessionViewportController {
  private state: SessionViewportState;
  private disposed = false;
  private pendingFrame: number | null = null;
  private pendingFreeRestore: number | null = null;
  private observer: ResizeObserver | null = null;

  private interacting = false;
  private interactionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly hasWindow = typeof window !== 'undefined';

  private readonly onScroll = (): void => {
    if (this.disposed) return;
    this.capture();
    if (!this.interacting) return;
    const distance = distanceFromBottom(this.viewport);
    if (this.state.mode === 'follow-bottom') {
      if (distance > VIEWPORT_BOTTOM_EXIT_PX) {
        this.state.mode = 'free';
        this.capture();
      }
    } else if (distance <= VIEWPORT_BOTTOM_ENTER_PX) {
      this.state.mode = 'follow-bottom';
      this.scheduleBottomAnchor();
    }
  };

  private readonly onResize = (): void => {
    if (this.disposed) return;
    if (this.state.mode === 'free') {
      if (this.pendingFreeRestore !== null) {
        const target = this.pendingFreeRestore;
        if (maxScrollTop(this.viewport) >= target) {
          this.pendingFreeRestore = null;
          this.writeScrollTop(target);
        } else {
          this.capture();
        }
      } else {
        this.capture();
      }
      return;
    }
    // follow-bottom: re-pin to the bottom unless the user is mid-gesture. If
    // they are (wheeling up to read history), do not yank them back; the
    // gesture end re-pins if they are still following.
    if (this.interacting) {
      this.capture();
      return;
    }
    this.scheduleBottomAnchor();
  };

  private readonly beginInteraction = (): void => {
    if (this.disposed) return;
    this.interacting = true;
    this.scheduleInteractionEnd();
  };

  private readonly keyInteraction = (event: KeyboardEvent): void => {
    if (this.disposed) return;
    if (!SCROLL_KEYS.has(event.key)) return;
    this.beginInteraction();
  };

  private readonly endInteraction = (): void => {
    if (this.disposed) return;
    this.scheduleInteractionEnd();
  };

  constructor(
    private readonly key: SessionKey,
    private readonly viewport: HTMLElement,
    content?: Element,
  ) {
    // Viewport intent is scoped to one continuous mount. Every entry (including
    // returning from another page or issue) starts at the live bottom; history
    // position is never restored across unmounts.
    this.state = {
      mode: 'follow-bottom',
      scrollTop: 0,
      ...metrics(viewport),
    };
    viewport.addEventListener('scroll', this.onScroll, { passive: true });
    viewport.addEventListener('wheel', this.beginInteraction, { passive: true });
    viewport.addEventListener('touchstart', this.beginInteraction, { passive: true });
    viewport.addEventListener('pointerdown', this.beginInteraction);
    viewport.addEventListener('keydown', this.keyInteraction);
    if (this.hasWindow) {
      // Release gestures that leave the viewport mid-drag still close the gate.
      window.addEventListener('pointerup', this.endInteraction, { passive: true });
      window.addEventListener('touchend', this.endInteraction, { passive: true });
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(viewport);
      if (content) this.observer.observe(content);
    }
    this.restoreBeforePaint();
  }

  private capture(): void {
    const current = metrics(this.viewport);
    this.state = {
      ...this.state,
      scrollTop: this.viewport.scrollTop,
      ...current,
    };
    memory.set(this.key, this.state);
  }

  private writeScrollTop(target: number): void {
    this.viewport.scrollTop = Math.max(0, target);
    this.capture();
  }

  private restoreBeforePaint(): void {
    const rememberedTop = this.state.scrollTop;
    const target = this.state.mode === 'follow-bottom'
      ? maxScrollTop(this.viewport)
      : Math.min(Math.max(0, rememberedTop), maxScrollTop(this.viewport));
    if (this.state.mode === 'free' && target < rememberedTop) {
      this.pendingFreeRestore = rememberedTop;
    }
    this.viewport.scrollTop = target;
    this.capture();
  }

  private scheduleBottomAnchor(): void {
    if (this.pendingFrame !== null) return;
    this.pendingFrame = frameRequest(() => {
      this.pendingFrame = null;
      if (this.disposed || this.state.mode !== 'follow-bottom') return;
      this.writeScrollTop(maxScrollTop(this.viewport));
    });
  }

  private scheduleInteractionEnd(): void {
    if (this.interactionTimer !== null) clearTimeout(this.interactionTimer);
    this.interactionTimer = setTimeout(() => {
      this.interactionTimer = null;
      if (this.disposed) return;
      this.interacting = false;
      // A user who settled back on the bottom expects to keep following.
      if (this.state.mode === 'follow-bottom') this.scheduleBottomAnchor();
    }, INTERACTION_RESET_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pendingFrame !== null) frameCancel(this.pendingFrame);
    this.pendingFrame = null;
    if (this.interactionTimer !== null) clearTimeout(this.interactionTimer);
    this.interactionTimer = null;
    this.capture();
    this.viewport.removeEventListener('scroll', this.onScroll);
    this.viewport.removeEventListener('wheel', this.beginInteraction);
    this.viewport.removeEventListener('touchstart', this.beginInteraction);
    this.viewport.removeEventListener('pointerdown', this.beginInteraction);
    this.viewport.removeEventListener('keydown', this.keyInteraction);
    if (this.hasWindow) {
      window.removeEventListener('pointerup', this.endInteraction);
      window.removeEventListener('touchend', this.endInteraction);
    }
    this.observer?.disconnect();
    this.observer = null;
    // Do not carry this browsing session into a later mount.
    memory.delete(this.key);
  }
}

export function getSessionViewportState(key: SessionKey): SessionViewportState | null {
  const state = memory.get(key);
  return state ? { ...state } : null;
}

export function clearSessionViewportState(key?: SessionKey): void {
  if (key) memory.delete(key);
  else memory.clear();
}
