/**
 * Report panel — 有日期的交付物. Reports are dated deliverables (analyses,
 * reviews, summaries) — editable while fresh — so the natural shape is a
 * timeline: newest first, bucketed by recency (今天 / 近7天 / 近30天 / 更早)
 * with sticky headers. Active vs 全部 mirrors the left lens (Backlog reports
 * are settled, hidden by default).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, FileWarning, Plus } from 'lucide-react';
import type { IrisWorkspace } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { collectDocs, docDate, type CollectedDoc } from '@renderer/lib/collect-docs';
import { docDisplayTitle } from '@renderer/lib/doc-utils';
import { setDocDragData } from '@renderer/lib/doc-drag';
import { StatusBadge } from '@renderer/components/ui/status-badge';
import { projectStore, useProject } from '@renderer/stores/project-store';
import { openCreateDialog } from '@renderer/components/doc/CreateDocDialog';
import { DocContextMenu } from '@renderer/components/doc/DocContextMenu';
import { Button } from '@renderer/components/ui/button';
import { PANEL_BAR, ROW_BASE } from './parts/layout';
import { GroupHeader } from './parts/GroupHeader';

const GRID = '76px minmax(0,1fr) auto minmax(0,96px)';

const BUCKETS = ['today', 'last7Days', 'last30Days', 'older', 'undated'] as const;
type Bucket = (typeof BUCKETS)[number];

interface ReportTimelineMemory {
  showAll: boolean;
  collapsed: ReadonlySet<string>;
  scrollTop: number;
}

const reportTimelineMemory = new Map<string, ReportTimelineMemory>();

const BUCKET_LABEL: Record<Bucket, 'collection.today' | 'collection.last7Days' | 'collection.last30Days' | 'collection.older' | 'collection.undated'> = {
  today: 'collection.today',
  last7Days: 'collection.last7Days',
  last30Days: 'collection.last30Days',
  older: 'collection.older',
  undated: 'collection.undated',
};

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function bucketOf(dateStr: string, today: string): Bucket {
  if (!dateStr) return 'undated';
  const diff = Math.round((Date.parse(today) - Date.parse(dateStr)) / 86_400_000);
  if (diff <= 0) return 'today';
  if (diff <= 7) return 'last7Days';
  if (diff <= 30) return 'last30Days';
  return 'older';
}

/** Reports stay active unless explicitly parked in Backlog. */
function isActiveReport(doc: { status: string | null }): boolean {
  return (doc.status ?? '').trim().toLowerCase() !== 'backlog';
}

export function ReportTimeline({
  root,
  workspacePath,
  selectedPath,
}: {
  root: IrisWorkspace;
  workspacePath: string | null;
  selectedPath?: string | null;
}): JSX.Element {
  const { t } = useTranslation();
  const { scope } = useProject();
  const memoryKey = `${scope?.root ?? ''}\u0000${workspacePath ?? ''}`;
  const memory = reportTimelineMemory.get(memoryKey);
  const [showAll, setShowAll] = useState(memory?.showAll ?? false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    memory?.collapsed ?? new Set(),
  );
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scrollTop = reportTimelineMemory.get(memoryKey)?.scrollTop ?? 0;
    reportTimelineMemory.set(memoryKey, { showAll, collapsed, scrollTop });
  }, [collapsed, memoryKey, showAll]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const frame = requestAnimationFrame(() => {
      list.scrollTop = reportTimelineMemory.get(memoryKey)?.scrollTop ?? 0;
    });
    return () => {
      cancelAnimationFrame(frame);
      const current = reportTimelineMemory.get(memoryKey);
      if (current) reportTimelineMemory.set(memoryKey, { ...current, scrollTop: list.scrollTop });
    };
  }, [memoryKey]);

  const today = todayStr();
  const rows = collectDocs(root, 'report', workspacePath).filter(
    (i) => showAll || isActiveReport(i.doc),
  );
  rows.sort(
    (a, b) => docDate(b.doc).localeCompare(docDate(a.doc)) || a.doc.path.localeCompare(b.doc.path),
  );

  const byBucket = new Map<Bucket, CollectedDoc[]>();
  for (const item of rows) {
    const b = bucketOf(docDate(item.doc), today);
    const arr = byBucket.get(b);
    if (arr) arr.push(item);
    else byBucket.set(b, [item]);
  }
  const groups = BUCKETS.filter((b) => byBucket.has(b)).map((b) => ({
    key: b,
    items: byBucket.get(b)!,
  }));

  const toggleCollapse = (key: string): void =>
    setCollapsed((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <div className="flex h-full flex-col">
      <div className={PANEL_BAR}>
        <h2 className="text-sm font-semibold">report</h2>
        <span className="text-[11px] text-muted-foreground">{t('collection.datedDeliverables')}</span>
        {workspacePath && (
          <button
            type="button"
            title={t('collection.clearWorkspaceFilter')}
            className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
            onClick={() => projectStore.openCollection('report', null)}
          >
            {workspacePath} ✕
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className={cn(
            'rounded px-2 py-0.5 text-[11px]',
            showAll ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {showAll ? t('collection.all') : t('collection.activeOnly')}
        </button>
        <span className="text-[11px] text-muted-foreground/60">{rows.length}</span>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto h-7"
          onClick={() =>
            openCreateDialog({
              workspacePath: workspacePath ?? '.iris',
              type: 'report',
              destination: 'collection',
            })
          }
        >
          <Plus /> {t('collection.new')}
        </Button>
      </div>

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-14"
        onScroll={(event) => {
          const current = reportTimelineMemory.get(memoryKey);
          if (current) {
            reportTimelineMemory.set(memoryKey, {
              ...current,
              scrollTop: event.currentTarget.scrollTop,
            });
          }
        }}
      >
        {groups.map((g) => (
          <div key={g.key}>
            <GroupHeader
              label={t(BUCKET_LABEL[g.key])}
              count={g.items.length}
              collapsed={collapsed.has(g.key)}
              onToggle={() => toggleCollapse(g.key)}
            />
            {!collapsed.has(g.key) &&
              g.items.map((item) => (
                <DocContextMenu
                  key={item.doc.path}
                  docPath={item.doc.path}
                  docName={item.doc.name}
                  onOpenInDefaultView={() =>
                    void projectStore.openCollectionDocInDefaultView(item.doc.path)
                  }
                >
                  <div
                    role="row"
                    onClick={() => void projectStore.selectCollectionDoc(item.doc.path)}
                    draggable
                    onDragStart={(e) => setDocDragData(e.dataTransfer, item.doc.path)}
                    title={item.doc.path}
                    style={{ gridTemplateColumns: GRID }}
                    className={cn(
                      ROW_BASE,
                      item.archived && 'opacity-50',
                      selectedPath === item.doc.path && 'bg-accent/80',
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--rp-foam)]/70" />
                      {docDate(item.doc) || '—'}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{docDisplayTitle(item.doc)}</span>
                      {item.doc.frontmatterBroken && (
                        <FileWarning className="h-3.5 w-3.5 shrink-0 text-destructive/80" />
                      )}
                      {item.archived && (
                        <Archive className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                      )}
                    </span>
                    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
                      {item.doc.status && <StatusBadge value={item.doc.status} size="sm" />}
                    </span>
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {item.workspaceName}
                    </span>
                  </div>
                </DocContextMenu>
              ))}
          </div>
        ))}
        {rows.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">
            {t('collection.noReports')}{!showAll && ` - ${t('collection.tryAll')}`}
          </div>
        )}
      </div>
    </div>
  );
}
