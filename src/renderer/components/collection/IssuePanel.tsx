/**
 * The issue panel — a Linear-style management list (软件定义书 §5 中栏:
 * issue 是重头戏). Rebuilt round-5:
 *   - one shared data-grid layout keeps every row aligned while metadata uses
 *     centered inner content tracks inside responsive outer column slots.
 *   - group-by (status/workspace/none) with sticky collapsible
 *     headers + counts; sort + order via the Display popover.
 *   - leading status glyph (click to edit) like Linear.
 *   - text search + active/on-hold/resolved/all + workspace filtering.
 *   - keyboard nav (j/k · Enter/o open · c new).
 *
 * All grouping/sorting is a deterministic pure projection over the scan; the
 * only writes are the existing per-doc frontmatter surgeries.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ChevronRight,
  FileWarning,
  Plus,
  Search,
} from 'lucide-react';
import type { IrisWorkspace } from '@shared/types';
import { ISSUE_STATUSES } from '@shared/document-status';
import { cn } from '@renderer/lib/utils';
import { collectDocs, docDate, type CollectedDoc } from '@renderer/lib/collect-docs';
import {
  docDisplayTitle,
  isActiveIssue,
  isInactiveOpenIssue,
  isResolvedIssue,
} from '@renderer/lib/doc-utils';
import { setDocDragData } from '@renderer/lib/doc-drag';
import { setDocStatus } from '@renderer/lib/issue-actions';
import { useViewPref } from '@renderer/lib/view-prefs';
import { compareDisplayText } from '@renderer/lib/locale';
import { StatusBadge } from '@renderer/components/ui/status-badge';
import { projectStore, useProject } from '@renderer/stores/project-store';
import { openCreateDialog } from '@renderer/components/doc/CreateDocDialog';
import { DocContextMenu } from '@renderer/components/doc/DocContextMenu';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import {
  PANEL_BAR,
  issueGridLayoutForWidth,
  type IssueGridLayout,
  type IssueInnerColumnWidths,
} from './parts/layout';
import { GroupHeader } from './parts/GroupHeader';
import {
  DisplayMenu,
  type GroupBy,
  type Order,
  type SortBy,
} from './parts/DisplayMenu';

type Filter = 'active' | 'onHold' | 'resolved' | 'all';

interface IssuePanelMemory {
  filter: Filter;
  query: string;
  collapsed: ReadonlySet<string>;
  activeIdx: number;
  scrollTop: number;
}

const issuePanelMemory = new Map<string, IssuePanelMemory>();

const FILTER_LABEL: Record<
  Filter,
  'collection.active' | 'collection.onHold' | 'collection.resolved' | 'collection.all'
> = {
  active: 'collection.active',
  onHold: 'collection.onHold',
  resolved: 'collection.resolved',
  all: 'collection.all',
};

const NO_STATUS = '__no_status__';

const DEFAULT_INNER_WIDTHS: IssueInnerColumnWidths = {
  status: 72,
  workspace: 56,
  date: 64,
};

function sameInnerColumnWidths(
  a: IssueInnerColumnWidths,
  b: IssueInnerColumnWidths,
): boolean {
  return (
    a.status === b.status &&
    a.workspace === b.workspace &&
    a.date === b.date
  );
}

function maxMeasuredWidth(root: HTMLElement, key: keyof IssueInnerColumnWidths): number {
  const elements = root.querySelectorAll<HTMLElement>(`[data-issue-measure="${key}"]`);
  let max = 0;
  elements.forEach((element) => {
    max = Math.max(max, Math.ceil(element.getBoundingClientRect().width));
  });
  return max;
}

function IssueGridCell({
  children,
  innerWidth,
  className,
  innerClassName,
}: {
  children: React.ReactNode;
  innerWidth: number;
  className?: string | undefined;
  innerClassName?: string | undefined;
}): JSX.Element {
  return (
    <div
      role="gridcell"
      className={cn('flex h-9 min-w-0 items-center justify-center overflow-hidden', className)}
    >
      <div
        className={cn('min-w-0 overflow-hidden text-left', innerClassName)}
        style={{ width: innerWidth }}
      >
        {children}
      </div>
    </div>
  );
}

function IssueTitleCell({
  item,
  selected,
}: {
  item: CollectedDoc;
  selected: boolean;
}): JSX.Element {
  return (
    <div
      role="gridcell"
      className="flex h-9 min-w-0 items-center justify-start gap-2 overflow-hidden px-3 text-left"
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
        {selected && (
          <ChevronRight className="h-3.5 w-3.5 text-[var(--rp-iris)] opacity-80" />
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        <span className="min-w-0 truncate">{docDisplayTitle(item.doc)}</span>
        {item.doc.frontmatterBroken && (
          <FileWarning className="h-3.5 w-3.5 shrink-0 text-destructive/80" />
        )}
        {item.archived && (
          <Archive className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}
      </span>
    </div>
  );
}

function IssueColumnMeasurer({
  rows,
  onMeasure,
}: {
  rows: CollectedDoc[];
  onMeasure: (widths: IssueInnerColumnWidths) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);

  const statusSamples = useMemo(() => {
    const seen = new Set<string>();
    return rows.flatMap((item) => {
      const editable = !item.archived && !item.doc.frontmatterBroken;
      const key = `${item.doc.status ?? ''}\u0000${editable ? '1' : '0'}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ status: item.doc.status, editable }];
    });
  }, [rows]);

  const workspaceSamples = useMemo(
    () => [...new Set(rows.map((item) => item.workspaceName))],
    [rows],
  );
  const dateSamples = useMemo(
    () => [...new Set(rows.map((item) => docDate(item.doc)))],
    [rows],
  );

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    onMeasure({
      status: maxMeasuredWidth(root, 'status') || DEFAULT_INNER_WIDTHS.status,
      workspace: maxMeasuredWidth(root, 'workspace') || DEFAULT_INNER_WIDTHS.workspace,
      date: maxMeasuredWidth(root, 'date') || DEFAULT_INNER_WIDTHS.date,
    });
  }, [dateSamples, onMeasure, statusSamples, workspaceSamples]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed top-0 z-[-1] flex flex-col items-start gap-1 whitespace-nowrap opacity-0"
      style={{ left: -10000 }}
    >
      {statusSamples.map(({ status, editable }) => (
        <span
          key={`${status ?? ''}\u0000${editable ? '1' : '0'}`}
          data-issue-measure="status"
          className="inline-flex min-w-0 items-center overflow-hidden"
        >
          {status ? (
            <StatusBadge value={status} chevron={editable} className="max-w-full" />
          ) : (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {editable ? t('collection.setStatus') : '—'}
            </span>
          )}
        </span>
      ))}
      {workspaceSamples.map((workspace) => (
        <span
          key={workspace}
          data-issue-measure="workspace"
          className="block text-[11px] text-muted-foreground"
        >
          {workspace}
        </span>
      ))}
      {dateSamples.map((date) => (
        <span
          key={date}
          data-issue-measure="date"
          className="block text-[11px] text-muted-foreground"
        >
          {date}
        </span>
      ))}
    </div>
  );
}

// ── inline status editor (the status badge doubles as an edit trigger) ────

function StatusEditor({ item }: { item: CollectedDoc }): JSX.Element {
  const { t } = useTranslation();
  const editable = !item.archived && !item.doc.frontmatterBroken;
  const badge = item.doc.status ? (
    <StatusBadge
      value={item.doc.status}
      chevron={editable}
      className="max-w-full"
    />
  ) : (
    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
      {editable ? t('collection.setStatus') : '—'}
    </span>
  );
  if (!editable)
    return (
      <span className="flex w-full min-w-0 max-w-full items-center overflow-hidden">
        {badge}
      </span>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full min-w-0 max-w-full items-center overflow-hidden"
          title={item.doc.status ?? t('collection.noStatus')}
          onClick={(e) => e.stopPropagation()}
        >
          {badge}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {ISSUE_STATUSES.map((s) => (
          <DropdownMenuItem
            key={s}
            onClick={(e) => {
              e.stopPropagation();
              void setDocStatus(item.doc.path, s);
            }}
          >
            <StatusBadge value={s} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── grouping / sorting (pure) ────────────────────────────────────────────

interface Group {
  key: string;
  label: string;
  glyph?: React.ReactNode;
  items: CollectedDoc[];
}

function statusRank(status: string | null): number {
  if (!status) return ISSUE_STATUSES.length + 1;
  const i = ISSUE_STATUSES.findIndex((s) => s.toLowerCase() === status.trim().toLowerCase());
  return i === -1 ? ISSUE_STATUSES.length : i;
}

function compare(a: CollectedDoc, b: CollectedDoc, sortBy: SortBy): number {
  switch (sortBy) {
    case 'date':
      return docDate(a.doc).localeCompare(docDate(b.doc));
    case 'title':
      return compareDisplayText(docDisplayTitle(a.doc), docDisplayTitle(b.doc));
    case 'status':
      return statusRank(a.doc.status) - statusRank(b.doc.status);
  }
}

function buildGroups(rows: CollectedDoc[], groupBy: GroupBy): Group[] {
  if (groupBy === 'none') return [{ key: '__all__', label: '', items: rows }];

  const map = new Map<string, CollectedDoc[]>();
  const add = (key: string, item: CollectedDoc): void => {
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  };

  for (const item of rows) {
    if (groupBy === 'status') add(item.doc.status ?? NO_STATUS, item);
    else if (groupBy === 'workspace') add(item.workspaceName, item);
  }

  const keys = [...map.keys()];
  keys.sort((x, y) => {
    if (groupBy === 'status') return statusRank(x === NO_STATUS ? null : x) - statusRank(y === NO_STATUS ? null : y);
    return compareDisplayText(x, y);
  });

  return keys.map((key) => ({
    key,
    label: key,
    glyph: undefined,
    items: map.get(key)!,
  }));
}

export function IssuePanel({
  root,
  workspacePath,
}: {
  root: IrisWorkspace;
  workspacePath: string | null;
}): JSX.Element {
  const { t } = useTranslation();
  const { view, scope } = useProject();
  const detailPath =
    view.kind === 'collection' && view.type === 'issue' ? view.selectedPath : null;
  const memoryKey = `${scope?.root ?? ''}\u0000${workspacePath ?? ''}`;
  const memory = issuePanelMemory.get(memoryKey);
  const [filter, setFilter] = useState<Filter>(memory?.filter ?? 'active');
  const [query, setQuery] = useState(memory?.query ?? '');
  const [prefs, setPrefs] = useViewPref('issue', {
    groupBy: 'status' as GroupBy,
    sortBy: 'date' as SortBy,
    order: 'desc' as Order,
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    memory?.collapsed ?? new Set(),
  );
  const [activeIdx, setActiveIdx] = useState(memory?.activeIdx ?? 0);
  const [listWidth, setListWidth] = useState(0);
  const [measuredInnerWidths, setMeasuredInnerWidths] =
    useState<IssueInnerColumnWidths>(DEFAULT_INNER_WIDTHS);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = (): void => {
      const width = list.clientWidth;
      setListWidth((previous) => (previous === width ? previous : width));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  const onMeasureInnerWidths = useCallback((widths: IssueInnerColumnWidths): void => {
    setMeasuredInnerWidths((previous) =>
      sameInnerColumnWidths(previous, widths) ? previous : widths,
    );
  }, []);

  useEffect(() => {
    const rememberedScrollTop = issuePanelMemory.get(memoryKey)?.scrollTop ?? 0;
    issuePanelMemory.set(memoryKey, {
      filter,
      query,
      collapsed,
      activeIdx,
      scrollTop: rememberedScrollTop,
    });
  }, [activeIdx, collapsed, filter, memoryKey, query]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const frame = requestAnimationFrame(() => {
      list.scrollTop = issuePanelMemory.get(memoryKey)?.scrollTop ?? 0;
    });
    return () => {
      cancelAnimationFrame(frame);
      const current = issuePanelMemory.get(memoryKey);
      if (current) issuePanelMemory.set(memoryKey, { ...current, scrollTop: list.scrollTop });
    };
  }, [memoryKey]);

  const q = query.trim().toLowerCase();
  const all = collectDocs(root, 'issue', workspacePath).filter((item) => {
    if (q) {
      const hay = `${docDisplayTitle(item.doc)} ${item.doc.name}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const counts: Record<Filter, number> = {
    active: all.filter((i) => !i.archived && isActiveIssue(i.doc)).length,
    onHold: all.filter((i) => !i.archived && isInactiveOpenIssue(i.doc)).length,
    resolved: all.filter((i) => isResolvedIssue(i.doc)).length,
    all: all.length,
  };

  const rows = all.filter((item) => {
    if (filter === 'active') return !item.archived && isActiveIssue(item.doc);
    if (filter === 'onHold') return !item.archived && isInactiveOpenIssue(item.doc);
    if (filter === 'resolved') return isResolvedIssue(item.doc);
    return true;
  });
  const dir = prefs.order === 'asc' ? 1 : -1;
  rows.sort(
    (a, b) =>
      dir * compare(a, b, prefs.sortBy) ||
      docDate(b.doc).localeCompare(docDate(a.doc)) ||
      a.doc.path.localeCompare(b.doc.path),
  );

  const gridLayout = useMemo<IssueGridLayout>(
    () => issueGridLayoutForWidth(listWidth, measuredInnerWidths),
    [listWidth, measuredInnerWidths],
  );
  const gridStyle = useMemo(
    () => ({ gridTemplateColumns: gridLayout.gridTemplateColumns }),
    [gridLayout.gridTemplateColumns],
  );

  const groups = useMemo(() => buildGroups(rows, prefs.groupBy), [rows, prefs.groupBy]);

  // Flattened visible rows (collapsed groups excluded) drive keyboard nav.
  const flat: CollectedDoc[] = [];
  for (const g of groups) if (!collapsed.has(g.key)) flat.push(...g.items);
  const flatIndex = new Map(flat.map((it, i) => [it.doc.path, i]));

  useEffect(() => {
    if (activeIdx >= flat.length && flat.length > 0) setActiveIdx(flat.length - 1);
  }, [flat.length, activeIdx]);
  useEffect(() => {
    rowRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const toggleCollapse = (key: string): void =>
    setCollapsed((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const target = e.target;
    if (
      target instanceof HTMLElement &&
      (target.matches('input, textarea') || target.isContentEditable)
    ) {
      return;
    }
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'o') {
      const it = flat[activeIdx];
      if (it) void projectStore.selectCollectionDoc(it.doc.path);
    } else if (e.key === 'c') {
      e.preventDefault();
      openCreateDialog({ workspacePath: workspacePath ?? '.iris', type: 'issue' });
    }
  };

  const openIssueInDefaultView = async (path: string): Promise<void> => {
    if (detailPath === path && projectStore.openIssueInDefaultView()) return;
    if (await projectStore.selectCollectionDoc(path)) {
      projectStore.openIssueInDefaultView();
    }
  };

  const scopeControl = workspacePath ? (
    <button
      type="button"
      title={t('collection.clearWorkspaceFilter')}
      className="min-w-0 max-w-28 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
      onClick={() => void projectStore.openCollection('issue', null)}
    >
      {workspacePath} ×
    </button>
  ) : null;

  const filterControl = (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
      {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => setFilter(f)}
          className={cn(
            'rounded px-2 py-0.5 text-[11px]',
            filter === f
              ? 'bg-background shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t(FILTER_LABEL[f])}
          <span className="ml-1 text-muted-foreground/60">{counts[f]}</span>
        </button>
      ))}
    </div>
  );

  const searchControl = (
    <div className="relative flex min-w-0 flex-1 items-center">
      <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('collection.searchPlaceholder')}
        className="h-7 w-full rounded-md border border-input bg-transparent pl-7 pr-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    </div>
  );

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden outline-none"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className={cn(PANEL_BAR, 'h-auto min-h-11 flex-wrap py-2')}>
        <h2 className="shrink-0 text-sm font-semibold">issue</h2>
        {scopeControl}
        {filterControl}
        <div className="ml-auto flex min-w-32 max-w-48 flex-1">{searchControl}</div>
        <DisplayMenu
          groupBy={prefs.groupBy}
          sortBy={prefs.sortBy}
          order={prefs.order}
          onChange={setPrefs}
        />
        <Button
          size="sm"
          variant="secondary"
          className="h-7 shrink-0"
          onClick={() => openCreateDialog({ workspacePath: workspacePath ?? '.iris', type: 'issue' })}
        >
          <Plus /> {t('collection.new')}
        </Button>
      </div>

      <IssueColumnMeasurer rows={rows} onMeasure={onMeasureInnerWidths} />

      <div
        ref={listRef}
        role="grid"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={(event) => {
          const current = issuePanelMemory.get(memoryKey);
          if (current) {
            issuePanelMemory.set(memoryKey, {
              ...current,
              scrollTop: event.currentTarget.scrollTop,
            });
          }
        }}
      >
        {groups.map((g) => (
          <div key={g.key}>
            {prefs.groupBy !== 'none' && (
              <GroupHeader
                label={g.key === NO_STATUS ? t('collection.noStatus') : g.label}
                count={g.items.length}
                collapsed={collapsed.has(g.key)}
                onToggle={() => toggleCollapse(g.key)}
                glyph={g.glyph}
              />
            )}
            {!collapsed.has(g.key) && (
              <div role="rowgroup">
                {g.items.map((item) => {
                  const i = flatIndex.get(item.doc.path) ?? -1;
                  return (
                    <DocContextMenu
                      key={item.doc.path}
                      docPath={item.doc.path}
                      docName={item.doc.name}
                      onOpenInDefaultView={() => void openIssueInDefaultView(item.doc.path)}
                    >
                      <div
                        ref={(el) => {
                          if (i >= 0) rowRefs.current[i] = el;
                        }}
                        role="row"
                        onClick={() => {
                          if (i >= 0) setActiveIdx(i);
                          void projectStore.selectCollectionDoc(item.doc.path);
                        }}
                        draggable
                        onDragStart={(e) => setDocDragData(e.dataTransfer, item.doc.path)}
                        title={item.doc.path}
                        style={gridStyle}
                        className={cn(
                          'group relative grid h-9 cursor-pointer select-none border-b border-subtle/60 text-sm hover:bg-muted/50',
                          item.archived && 'opacity-50',
                          detailPath === item.doc.path && 'bg-accent/80',
                          i === activeIdx &&
                            detailPath !== item.doc.path &&
                            'bg-muted/50',
                        )}
                      >
                        <IssueTitleCell
                          item={item}
                          selected={detailPath === item.doc.path}
                        />
                        <IssueGridCell
                          innerWidth={gridLayout.inner.status}
                          innerClassName="flex h-9 items-center"
                        >
                          <StatusEditor item={item} />
                        </IssueGridCell>
                        <IssueGridCell
                          innerWidth={gridLayout.inner.workspace}
                          innerClassName="h-9 text-[11px] leading-9 text-muted-foreground"
                        >
                          <span className="block min-w-0 truncate">{item.workspaceName}</span>
                        </IssueGridCell>
                        <IssueGridCell
                          innerWidth={gridLayout.inner.date}
                          innerClassName="h-9 text-left text-[11px] leading-9 text-muted-foreground"
                        >
                          <span className="block min-w-0 truncate">{docDate(item.doc)}</span>
                        </IssueGridCell>
                      </div>
                    </DocContextMenu>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {flat.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">
            {t('collection.noIssues')}
          </div>
        )}
      </div>

    </div>
  );
}
