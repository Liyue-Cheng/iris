/**
 * Report panel — "冻结的过去". Reports are append-only dated snapshots, so the
 * natural shape is a timeline: newest first, bucketed by recency (今天 / 近7天
 * / 近30天 / 更早) with sticky headers. Active vs 全部 mirrors the left lens
 * (Backlog reports are settled, hidden by default).
 */
import { useState } from 'react';
import { Archive, FileWarning, Plus } from 'lucide-react';
import type { IrisWorkspace } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { collectDocs, docDate, type CollectedDoc } from '@renderer/lib/collect-docs';
import { docDisplayTitle } from '@renderer/lib/doc-utils';
import { setDocDragData } from '@renderer/lib/doc-drag';
import { LabelChip } from '@renderer/components/ui/label-chip';
import { StatusBadge } from '@renderer/components/ui/status-badge';
import { projectStore } from '@renderer/stores/project-store';
import { openCreateDialog } from '@renderer/components/doc/CreateDocDialog';
import { DocContextMenu } from '@renderer/components/doc/DocContextMenu';
import { Button } from '@renderer/components/ui/button';
import { PANEL_BAR, ROW_BASE } from './parts/layout';
import { GroupHeader } from './parts/GroupHeader';

const GRID = '76px minmax(0,1fr) auto minmax(0,96px)';

const BUCKETS = ['今天', '近7天', '近30天', '更早', '无日期'] as const;
type Bucket = (typeof BUCKETS)[number];

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function bucketOf(dateStr: string, today: string): Bucket {
  if (!dateStr) return '无日期';
  const diff = Math.round((Date.parse(today) - Date.parse(dateStr)) / 86_400_000);
  if (diff <= 0) return '今天';
  if (diff <= 7) return '近7天';
  if (diff <= 30) return '近30天';
  return '更早';
}

/** Reports stay active unless explicitly parked in Backlog. */
function isActiveReport(doc: { status: string | null }): boolean {
  return (doc.status ?? '').trim().toLowerCase() !== 'backlog';
}

export function ReportTimeline({
  root,
  workspacePath,
}: {
  root: IrisWorkspace;
  workspacePath: string | null;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

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
        <h2 className="text-sm font-semibold">Report</h2>
        <span className="text-[11px] text-muted-foreground">冻结的过去</span>
        {workspacePath && (
          <button
            type="button"
            title="清除工作区过滤"
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
          {showAll ? '全部' : '仅活动'}
        </button>
        <span className="text-[11px] text-muted-foreground/60">{rows.length}</span>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto h-7"
          onClick={() => openCreateDialog({ workspacePath: workspacePath ?? '.iris', type: 'report' })}
        >
          <Plus /> 新建
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {groups.map((g) => (
          <div key={g.key}>
            <GroupHeader
              label={g.key}
              count={g.items.length}
              collapsed={collapsed.has(g.key)}
              onToggle={() => toggleCollapse(g.key)}
            />
            {!collapsed.has(g.key) &&
              g.items.map((item) => (
                <DocContextMenu key={item.doc.path} docPath={item.doc.path} docName={item.doc.name}>
                  <div
                    role="row"
                    onClick={() => void projectStore.selectDoc(item.doc.path)}
                    draggable
                    onDragStart={(e) => setDocDragData(e.dataTransfer, item.doc.path)}
                    title={item.doc.path}
                    style={{ gridTemplateColumns: GRID }}
                    className={cn(ROW_BASE, item.archived && 'opacity-50')}
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
                      {item.doc.labels.slice(0, 1).map((l) => (
                        <LabelChip key={l} label={l} />
                      ))}
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
            没有 report{!showAll && ' — 试试「全部」'}
          </div>
        )}
      </div>
    </div>
  );
}
