/**
 * Shared layout vocabulary for the collection panels (issue / status / report
 * / misc). One source of truth for row height, padding, the toolbar bar and
 * the grid track — so the four panels line up pixel-for-pixel and switching
 * between them doesn't make rows jump (issue 三.6).
 *
 * The hard rules that fix the truncation/wrap bugs (issue 三.1–5) live here:
 *   - fixed-height rows, single-line cells, and shared visual spacing;
 *   - issue rows use one shared data-grid column model;
 *   - issue metadata columns have an outer slot and a centered inner content
 *     track, so short metadata stays visually compact without row-by-row
 *     drift;
 *   - secondary content is clipped inside its cell, never painted over a
 *     neighboring column.
 */

/** The top bar shared by every panel header. */
export const PANEL_BAR = 'flex h-11 shrink-0 items-center gap-2 border-b border-subtle bg-card/30 px-3';

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

export interface IssueColumnWidths {
  title: number;
  status: number;
  workspace: number;
  date: number;
}

export interface IssueInnerColumnWidths {
  status: number;
  workspace: number;
  date: number;
}

export interface IssueGridLayout {
  titleWidth: number;
  outer: IssueInnerColumnWidths;
  inner: IssueInnerColumnWidths;
  gridTemplateColumns: string;
}

const ISSUE_COLUMN_POINTS: readonly [
  { width: number; columns: IssueColumnWidths },
  ...Array<{ width: number; columns: IssueColumnWidths }>,
] = [
  { width: 298, columns: { title: 106, status: 72, workspace: 56, date: 64 } },
  { width: 330, columns: { title: 130, status: 72, workspace: 56, date: 72 } },
  { width: 490, columns: { title: 226, status: 112, workspace: 80, date: 72 } },
  { width: 720, columns: { title: 362, status: 128, workspace: 158, date: 72 } },
  { width: 850, columns: { title: 442, status: 136, workspace: 200, date: 72 } },
];

function interpolateColumns(
  from: IssueColumnWidths,
  to: IssueColumnWidths,
  ratio: number,
): IssueColumnWidths {
  const lerp = (a: number, b: number): number => a + (b - a) * ratio;
  return {
    title: lerp(from.title, to.title),
    status: lerp(from.status, to.status),
    workspace: lerp(from.workspace, to.workspace),
    date: lerp(from.date, to.date),
  };
}

function roundColumns(availableWidth: number, columns: IssueColumnWidths): IssueColumnWidths {
  const title = Math.floor(columns.title);
  const status = Math.floor(columns.status);
  const workspace = Math.floor(columns.workspace);
  const date = Math.floor(columns.date);
  const remainder = availableWidth - title - status - workspace - date;

  return {
    title: title + remainder,
    status,
    workspace,
    date,
  };
}

function cssPixels(width: number): string {
  return `${Math.max(0, Math.round(width))}px`;
}

function finiteWidth(width: number | undefined): number {
  return Math.max(0, Math.ceil(Number.isFinite(width) ? width ?? 0 : 0));
}

/**
 * Pure column-width allocation for the Issue master list. The output always
 * preserves all four layout columns and sums exactly to the available width.
 */
export function issueColumnWidthsForWidth(width: number): IssueColumnWidths {
  const availableWidth = Math.max(0, Math.round(Number.isFinite(width) ? width : 0));
  const lossyFloor = ISSUE_COLUMN_POINTS[0];
  const points = ISSUE_COLUMN_POINTS.slice(1);

  if (availableWidth < lossyFloor.width) {
    const ratio = lossyFloor.width === 0 ? 0 : availableWidth / lossyFloor.width;
    return roundColumns(availableWidth, {
      title: lossyFloor.columns.title * ratio,
      status: lossyFloor.columns.status * ratio,
      workspace: lossyFloor.columns.workspace * ratio,
      date: lossyFloor.columns.date * ratio,
    });
  }

  let previous = lossyFloor;
  for (const point of points) {
    if (availableWidth <= point.width) {
      const ratio = (availableWidth - previous.width) / (point.width - previous.width);
      return roundColumns(
        availableWidth,
        interpolateColumns(previous.columns, point.columns, ratio),
      );
    }
    previous = point;
  }

  return {
    title: availableWidth - 408,
    status: 136,
    workspace: 200,
    date: 72,
  };
}

export function issueGridTemplateColumns(columns: IssueInnerColumnWidths): string {
  return [
    'minmax(0, 1fr)',
    columns.status,
    columns.workspace,
    columns.date,
  ].map((column) => (typeof column === 'number' ? cssPixels(column) : column)).join(' ');
}

export function issueInnerColumnWidthsForColumns(
  outer: IssueInnerColumnWidths,
  measured: Partial<IssueInnerColumnWidths> = {},
): IssueInnerColumnWidths {
  return {
    status: Math.min(outer.status, finiteWidth(measured.status)),
    workspace: Math.min(outer.workspace, finiteWidth(measured.workspace)),
    date: Math.min(outer.date, finiteWidth(measured.date)),
  };
}

export function issueGridLayoutForWidth(
  width: number,
  measured: Partial<IssueInnerColumnWidths> = {},
): IssueGridLayout {
  const columns = issueColumnWidthsForWidth(width);
  const outer: IssueInnerColumnWidths = {
    status: columns.status,
    workspace: columns.workspace,
    date: columns.date,
  };
  return {
    titleWidth: columns.title,
    outer,
    inner: issueInnerColumnWidthsForColumns(outer, measured),
    gridTemplateColumns: issueGridTemplateColumns(outer),
  };
}
