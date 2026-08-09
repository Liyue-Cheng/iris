/**
 * The issue panel — a Linear-style management list (软件定义书 §5 中栏:
 * issue 是重头戏). Rebuilt round-5:
 *   - CSS-grid rows (not an auto <table>): title is the dominant column and
 *     everything truncates to a single line — no more撑宽/换行 (issue 三).
 *   - group-by (status/workspace/none) with sticky collapsible
 *     headers + counts; sort + order via the Display popover.
 *   - leading status glyph (click to edit) like Linear.
 *   - text search + active/resolved/all + workspace filtering.
 *   - keyboard nav (j/k · Enter/o open · c new · x select · Esc clear) and
 *     multi-select with a bulk action bar.
 *
 * All grouping/sorting is a deterministic pure projection over the scan; the
 * only writes are the existing per-doc frontmatter surgeries.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  CheckSquare,
  FileWarning,
  Plus,
  Search,
  Square,
  X,
} from 'lucide-react';
import type { IrisWorkspace } from '@shared/types';
import { ISSUE_STATUSES } from '@shared/document-status';
import { cn } from '@renderer/lib/utils';
import { collectDocs, docDate, type CollectedDoc } from '@renderer/lib/collect-docs';
import { docDisplayTitle, isActiveIssue } from '@renderer/lib/doc-utils';
import { setDocDragData } from '@renderer/lib/doc-drag';
import { setDocsStatus, setDocStatus } from '@renderer/lib/issue-actions';
import { useViewPref } from '@renderer/lib/view-prefs';
import { compareDisplayText } from '@renderer/lib/locale';
import { StatusBadge } from '@renderer/components/ui/status-badge';
import { projectStore } from '@renderer/stores/project-store';
import { openCreateDialog } from '@renderer/components/doc/CreateDocDialog';
import { DocContextMenu } from '@renderer/components/doc/DocContextMenu';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { PANEL_BAR, ROW_BASE } from './parts/layout';
import { GroupHeader } from './parts/GroupHeader';
import {
  DisplayMenu,
  type GroupBy,
  type Order,
  type SortBy,
} from './parts/DisplayMenu';

type Filter = 'active' | 'resolved' | 'all';

const FILTER_LABEL: Record<Filter, 'collection.active' | 'collection.resolved' | 'collection.all'> = {
  active: 'collection.active',
  resolved: 'collection.resolved',
  all: 'collection.all',
};

const NO_STATUS = '__no_status__';

/**
 * Column track shared by every issue row. Order: select · title · status ·
 * workspace · date. The title is content-sized but capped at 400px
 * (short titles → narrow column, long titles truncate); STATUS is the single
 * flexible 1fr column, so it absorbs the row's slack — with its badge left-
 * aligned the badge hugs the title's right edge and naturally drifts left for
 * short titles. workspace/date stay fixed-width and right-anchored at the far
 * edge (the 1fr to their left keeps them aligned across rows, each row being
 * its own grid). All cells min-w-0 + single-line truncate.
 */
const GRID = '18px minmax(0,400px) minmax(0,1fr) 88px 72px';

// ── inline status editor (the status badge doubles as an edit trigger) ────

function StatusEditor({ item }: { item: CollectedDoc }): JSX.Element {
  const { t } = useTranslation();
  const editable = !item.archived && !item.doc.frontmatterBroken;
  const badge = item.doc.status ? (
    <StatusBadge value={item.doc.status} chevron={editable} />
  ) : (
    <span className="text-[11px] text-muted-foreground">{editable ? t('collection.setStatus') : '—'}</span>
  );
  if (!editable)
    return <span className="flex items-center justify-self-start">{badge}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-self-start"
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
  const [filter, setFilter] = useState<Filter>('active');
  const [query, setQuery] = useState('');
  const [prefs, setPrefs] = useViewPref('issue', {
    groupBy: 'status' as GroupBy,
    sortBy: 'date' as SortBy,
    order: 'desc' as Order,
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [activeIdx, setActiveIdx] = useState(0);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

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
    resolved: all.filter((i) => !isActiveIssue(i.doc)).length,
    all: all.length,
  };

  const rows = all.filter((item) => {
    if (filter === 'active') return !item.archived && isActiveIssue(item.doc);
    if (filter === 'resolved') return !isActiveIssue(item.doc);
    return true;
  });
  const dir = prefs.order === 'asc' ? 1 : -1;
  rows.sort(
    (a, b) =>
      dir * compare(a, b, prefs.sortBy) ||
      docDate(b.doc).localeCompare(docDate(a.doc)) ||
      a.doc.path.localeCompare(b.doc.path),
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

  const toggleSelect = (path: string): void =>
    setSelected((p) => {
      const n = new Set(p);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'o') {
      const it = flat[activeIdx];
      if (it) void projectStore.selectDoc(it.doc.path);
    } else if (e.key === 'x') {
      const it = flat[activeIdx];
      if (it) {
        e.preventDefault();
        toggleSelect(it.doc.path);
      }
    } else if (e.key === 'c') {
      e.preventDefault();
      openCreateDialog({ workspacePath: workspacePath ?? '.iris', type: 'issue' });
    } else if (e.key === 'Escape') {
      setSelected(new Set());
    }
  };

  const applyBulkStatus = async (status: string): Promise<void> => {
    await setDocsStatus([...selected], status);
    setSelected(new Set());
  };

  return (
    <div
      className="flex h-full flex-col outline-none"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className={PANEL_BAR}>
        <h2 className="shrink-0 text-sm font-semibold">issue</h2>
        {workspacePath && (
          <button
            type="button"
            title={t('collection.clearWorkspaceFilter')}
            className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
            onClick={() => projectStore.openCollection('issue', null)}
          >
            {workspacePath} ✕
          </button>
        )}
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
        <div className="relative ml-auto flex min-w-0 max-w-48 flex-1 items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('collection.searchPlaceholder')}
            className="h-7 w-full rounded-md border border-input bg-transparent pl-7 pr-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
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

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
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
            {!collapsed.has(g.key) &&
              g.items.map((item) => {
                const i = flatIndex.get(item.doc.path) ?? -1;
                const isSel = selected.has(item.doc.path);
                return (
                  <DocContextMenu
                    key={item.doc.path}
                    docPath={item.doc.path}
                    docName={item.doc.name}
                  >
                    <div
                      ref={(el) => {
                        if (i >= 0) rowRefs.current[i] = el;
                      }}
                      role="row"
                      onClick={(e) => {
                        if (e.ctrlKey || e.metaKey) toggleSelect(item.doc.path);
                        else {
                          if (i >= 0) setActiveIdx(i);
                          void projectStore.selectDoc(item.doc.path);
                        }
                      }}
                      draggable
                      onDragStart={(e) => setDocDragData(e.dataTransfer, item.doc.path)}
                      title={item.doc.path}
                      style={{ gridTemplateColumns: GRID }}
                      className={cn(
                        ROW_BASE,
                        item.archived && 'opacity-50',
                        isSel && 'bg-[var(--rp-iris)]/10',
                        i === activeIdx && 'bg-muted/70 ring-1 ring-inset ring-[var(--rp-iris)]/40',
                      )}
                    >
                      <button
                        type="button"
                        title={t('collection.select')}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelect(item.doc.path);
                        }}
                        className={cn(
                          'flex h-4 w-4 items-center justify-center text-muted-foreground',
                          isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-60',
                        )}
                      >
                        {isSel ? (
                          <CheckSquare className="h-3.5 w-3.5 text-[var(--rp-iris)]" />
                        ) : (
                          <Square className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{docDisplayTitle(item.doc)}</span>
                        {item.doc.frontmatterBroken && (
                          <FileWarning className="h-3.5 w-3.5 shrink-0 text-destructive/80" />
                        )}
                        {item.archived && (
                          <Archive className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                        )}
                      </span>
                      <StatusEditor item={item} />
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                        {item.workspaceName}
                      </span>
                      <span className="text-right text-[11px] text-muted-foreground">
                        {docDate(item.doc)}
                      </span>
                    </div>
                  </DocContextMenu>
                );
              })}
          </div>
        ))}
        {flat.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">
            {t('collection.noIssues')}
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-subtle bg-card px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">{t('collection.selectedCount', { count: selected.size })}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]">
                {t('collection.changeStatus')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {ISSUE_STATUSES.map((s) => (
                <DropdownMenuItem
                  key={s}
                  onClick={() => void applyBulkStatus(s)}
                >
                  <StatusBadge value={s} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" /> {t('common.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}
