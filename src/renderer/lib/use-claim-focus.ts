/**
 * @file lib/use-claim-focus.ts
 * @purpose A focusable region claims keyboard focus when (a) it is the current
 *   focus intent's target, (b) that intent token hasn't been claimed yet, and
 *   (c) the region reports itself ready. Each intent token is claimed at most
 *   once, so a remount alone never re-grabs focus (fixes P5: the terminal
 *   stealing focus on every reveal) — only a fresh request() does.
 *
 * `claim` is read through a ref so callers can pass a fresh closure every
 * render (e.g. one that reads the latest editor view) without re-running the
 * effect; the effect re-runs only on intent / ready / target changes.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { focusStore, useFocusIntent, type FocusTarget } from '@renderer/stores/focus-store';

export function useClaimFocus(target: FocusTarget, claim: () => void, ready = true): void {
  const intent = useFocusIntent();
  const claimRef = useRef(claim);
  claimRef.current = claim;
  const claimedToken = useRef(-1);

  useEffect(() => {
    if (!ready) return;
    if (intent.target !== target) return;
    if (intent.token === claimedToken.current) return;
    claimedToken.current = intent.token;
    claimRef.current();
    focusStore.markClaimed(target);
  }, [intent.token, intent.target, ready, target]);
}

/**
 * Convenience for collection panels (P4): returns a ref to put on the panel's
 * focusable root; the panel claims 'panel' focus whenever a collection/todos
 * view opens, so keyboard nav (j/k in IssuePanel) and scroll keys work without
 * a preliminary mouse click. Give the root `tabIndex` (0 for keyboard-nav
 * panels, -1 otherwise) and `outline-none`.
 */
export function usePanelFocusRef(): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useClaimFocus('panel', () => ref.current?.focus());
  return ref;
}
