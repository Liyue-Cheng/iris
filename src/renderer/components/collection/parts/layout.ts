/**
 * Shared layout vocabulary for the collection panels (issue / status / report
 * / misc). One source of truth for row height, padding, the toolbar bar and
 * the grid track — so the four panels line up pixel-for-pixel and switching
 * between them doesn't make rows jump (issue 三.6).
 *
 * The hard rules that fix the truncation/wrap bugs (issue 三.1–5) live here:
 *   - every panel is a CSS grid with `min-w-0` cells, never an auto <table>;
 *   - the title column is `minmax(0,1fr)` (dominant + truncatable);
 *   - secondary columns are shrinkable, content never wraps.
 */

/** The top bar shared by every panel header. */
export const PANEL_BAR = 'flex h-9 shrink-0 items-center gap-2 border-b border-subtle bg-card/30 px-3';

/** A single list row: fixed height, single line, consistent hover. */
export const ROW_BASE =
  'group grid h-9 items-center gap-2 px-3 text-sm cursor-pointer select-none border-b border-subtle/60 hover:bg-muted/50';

/** Sticky group header inside the scroll area. */
export const GROUP_BAR =
  'sticky top-0 z-10 flex h-7 items-center gap-2 bg-card px-3 text-xs text-muted-foreground';

/** A cell whose text must truncate to a single line. */
export const CELL_TRUNCATE = 'min-w-0 truncate';

/** Right-aligned muted meta cell (workspace / date). */
export const CELL_META = 'min-w-0 truncate text-[11px] text-muted-foreground';
