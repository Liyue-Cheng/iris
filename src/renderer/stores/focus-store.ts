/**
 * @file stores/focus-store.ts
 * @purpose Central keyboard-focus intent coordinator. Navigation actions
 *   DECLARE where focus should go (request); focusable regions CLAIM it once
 *   they are ready (useClaimFocus). This replaces the old "whoever mounts /
 *   reveals last grabs .focus()" model that made focus land late, get dropped,
 *   or be stolen (issue 2026-06-16 关于焦点的的管理 — P1/P4/P5/P6).
 *
 * Not a pipeline instruction: keyboard focus is ephemeral DOM state, not a
 * world-changing write (CQRS boundary), so it lives in the projection layer
 * alongside the other stores. It imports no other store (no cycles).
 */
import { useSyncExternalStore } from 'react';

export type FocusTarget = 'editor' | 'terminal' | 'panel';

export interface FocusIntent {
  target: FocusTarget;
  /** Monotonic — a region claims any intent at most once, and only the latest,
   *  so a bare remount never re-grabs focus (the root of P5). */
  token: number;
}

let intent: FocusIntent = { target: 'editor', token: 0 };
/** The last target a region actually took focus for — re-asserted on window
 *  re-focus (P6). */
let lastClaimed: FocusTarget | null = null;
const subscribers = new Set<() => void>();

function emit(): void {
  subscribers.forEach((cb) => cb());
}

export const focusStore = {
  get(): FocusIntent {
    return intent;
  },

  /** Declare where keyboard focus should go next. The matching region claims
   *  it when ready (mount / reveal), so order-of-arrival doesn't matter and
   *  callers never need to know whether the target is mounted yet. */
  request(target: FocusTarget): void {
    intent = { target, token: intent.token + 1 };
    emit();
  },

  /** Re-assert the last successfully-claimed target (window re-focus, P6). */
  restore(): void {
    if (lastClaimed) this.request(lastClaimed);
  },

  /** Called by useClaimFocus when a region actually took focus. */
  markClaimed(target: FocusTarget): void {
    lastClaimed = target;
  },
};

export function useFocusIntent(): FocusIntent {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    () => intent,
  );
}
