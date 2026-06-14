/**
 * Per-key scroll memory for the document body editors (round-4 C1/C2).
 * Switching away from a doc unmounts the editor; remounting it (doc switch,
 * collection-view round trip, mode toggle) used to reset the reading position.
 *
 * There is NO Milkdown/ProseMirror "scroll position" API (see
 * docs/milkdown-crepe-api.md); the scroll container is a plain DOM element
 * whose identity depends on theme CSS. We DON'T try to name it:
 *   - SAVE: capture-phase 'scroll' on document; the real scroller is the
 *     element that fired AND encloses the content node (`t.contains(content)`).
 *     Nested code-block scrollers sit INSIDE the content, so they fail it.
 *   - RESTORE: write the target scrollTop onto every scrollable ancestor of
 *     the content; whichever one is the real scroller takes it.
 *
 * THE RATCHET BUG (scroll crept up a chunk on every switch): setting scrollTop
 * programmatically also fires 'scroll', and during restore the content isn't
 * laid out yet so the write clamps to a smaller value. With the save listener
 * live, those clamped values overwrote the good saved position — a downward
 * ratchet that walked to the top over a few remounts.
 *
 * Fix: a `restoring` gate. While restoring, every 'scroll' (all of them ours)
 * is ignored, so only genuine user scrolls are ever persisted. The saved value
 * therefore stays put across remounts and the position is stable.
 *
 * Key namespaces the mode ('wysiwyg:'/'source:') because Crepe and CodeMirror
 * have different scroll metrics for the same file.
 */
const positions = new Map<string, number>();

export function rememberScroll(key: string, top: number): void {
  positions.set(key, top);
}

export function recallScroll(key: string): number {
  return positions.get(key) ?? 0;
}

const STABLE_FRAMES = 3; // content height unchanged this many frames → laid out
const MAX_FRAMES = 120; // ~2s ceiling so restore never spins forever

export interface ScrollKeeper {
  stop(): void;
}

/**
 * Restore the saved position for `key`, then keep it in sync with user
 * scrolls. `content` is any node inside the scroller (Crepe: the ProseMirror
 * view.dom; CodeMirror: view.scrollDOM, which is itself the scroller).
 */
export function attachScrollMemory(opts: { key: string; content: HTMLElement }): ScrollKeeper {
  const { key, content } = opts;
  let restoring = false;
  let stopped = false;

  const onScroll = (e: Event): void => {
    if (restoring || stopped) return; // ignore our own restore-driven scrolls
    const t = e.target;
    if (t instanceof HTMLElement && t.contains(content)) {
      rememberScroll(key, t.scrollTop);
    }
  };
  document.addEventListener('scroll', onScroll, true);

  const target = recallScroll(key);
  if (target > 0) {
    restoring = true;
    let frames = 0;
    let stable = 0;
    let lastHeight = -1;
    const tick = (): void => {
      if (stopped) {
        restoring = false;
        return;
      }
      // Write target onto every scrollable ancestor of content; the real
      // scroller accepts it, non-scrollable boxes ignore it. Track the
      // outermost scroller's height to detect "content laid out".
      let el: HTMLElement | null = content;
      let height = -1;
      for (let hops = 0; el && hops < 8; hops++) {
        if (el.scrollHeight > el.clientHeight + 1) {
          el.scrollTop = target;
          height = el.scrollHeight;
        }
        el = el.parentElement;
      }
      if (height === lastHeight) stable += 1;
      else {
        stable = 0;
        lastHeight = height;
      }
      // Done when the layout has settled (height stable) or we hit the ceiling.
      if (stable >= STABLE_FRAMES || ++frames >= MAX_FRAMES) {
        restoring = false;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  return {
    stop(): void {
      stopped = true;
      restoring = false;
      document.removeEventListener('scroll', onScroll, true);
    },
  };
}
