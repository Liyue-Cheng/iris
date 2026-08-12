const positions = new Map<string, number>();

export interface ScrollMemoryHandle {
  override(): void;
  stop(): void;
}

/** Persist one editor scroller and restore it after asynchronous layout. The
 * document-level pointer guard also preserves the current position while a
 * focused editor yields focus to toolbar, Git or terminal controls. */
export function attachScrollMemory(options: {
  key: string;
  scroller: HTMLElement;
  focusRoot?: HTMLElement;
}): ScrollMemoryHandle {
  const { key, scroller, focusRoot = scroller } = options;
  let stopped = false;
  let restoring = positions.has(key);
  let frame: number | null = null;
  let stableFrames = 0;
  let previousHeight = -1;

  const remember = (): void => {
    if (!restoring) positions.set(key, scroller.scrollTop);
  };

  const restoreForLayout = (target: number, remaining = 18): void => {
    if (stopped) return;
    restoring = true;
    scroller.scrollTop = target;
    const height = scroller.scrollHeight;
    stableFrames = height === previousHeight ? stableFrames + 1 : 0;
    previousHeight = height;
    if (remaining <= 0 || stableFrames >= 2) {
      restoring = false;
      positions.set(key, scroller.scrollTop);
      frame = null;
      return;
    }
    frame = requestAnimationFrame(() => restoreForLayout(target, remaining - 1));
  };

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node) || focusRoot.contains(target)) return;
    const active = document.activeElement;
    if (!(active instanceof Node) || !focusRoot.contains(active)) return;
    const preserved = scroller.scrollTop;
    requestAnimationFrame(() => restoreForLayout(preserved, 3));
  };

  scroller.addEventListener('scroll', remember, { passive: true });
  document.addEventListener('pointerdown', onPointerDown, true);
  const initial = positions.get(key);
  if (initial !== undefined) restoreForLayout(initial);
  else restoring = false;

  return {
    override(): void {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      restoring = false;
      positions.set(key, scroller.scrollTop);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (frame !== null) cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', remember);
      document.removeEventListener('pointerdown', onPointerDown, true);
      positions.set(key, scroller.scrollTop);
    },
  };
}

export function clearScrollMemory(): void {
  positions.clear();
}
