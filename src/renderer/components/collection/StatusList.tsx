/**
 * Status panel — "当前真相". Beyond a plain list it surfaces each status doc's
 * freshness: CONVENTIONS stamps `reflects: <sha>`; we compare it to the live
 * git HEAD so a stale snapshot is obvious at a glance (trust calibration, §8).
 * HEAD is a best-effort read (project:git-head) — when git is unavailable the
 * freshness column simply goes quiet.
 */
import { useEffect, useState } from 'react';
import { Archive, FileWarning, Plus } from 'lucide-react';
import type { IrisWorkspace } from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { cn } from '@renderer/lib/utils';
import { collectDocs, docDate } from '@renderer/lib/collect-docs';
import { docDisplayTitle } from '@renderer/lib/doc-utils';
import { setDocDragData } from '@renderer/lib/doc-drag';
import { projectStore } from '@renderer/stores/project-store';
import { openCreateDialog } from '@renderer/components/doc/CreateDocDialog';
import { DocContextMenu } from '@renderer/components/doc/DocContextMenu';
import { Button } from '@renderer/components/ui/button';
import { PANEL_BAR, ROW_BASE } from './parts/layout';

const GRID = 'minmax(0,1fr) auto minmax(0,96px) 76px';

/** Two shas refer to the same commit when one is a prefix of the other (≥7). */
function shaMatch(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

function reflectsOf(doc: { frontmatter: Record<string, unknown> | null }): string | null {
  const v = doc.frontmatter?.['reflects'];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function Freshness({ reflects, head }: { reflects: string | null; head: string | null }): JSX.Element {
  if (!reflects) {
    return <span className="text-[11px] text-muted-foreground/50">未标注</span>;
  }
  const short = reflects.slice(0, 7);
  if (!head) {
    return (
      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {short}
      </span>
    );
  }
  const fresh = shaMatch(reflects, head);
  return (
    <span
      title={`reflects ${short} · HEAD ${head.slice(0, 7)}`}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
        fresh
          ? 'bg-[var(--rp-pine)]/15 text-[var(--rp-pine)]'
          : 'bg-[var(--rp-gold)]/15 text-[var(--rp-gold)]',
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {fresh ? '最新' : '已落后'}
    </span>
  );
}

export function StatusList({
  root,
  workspacePath,
}: {
  root: IrisWorkspace;
  workspacePath: string | null;
}): JSX.Element {
  const [head, setHead] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const fetchHead = (): void => {
      window.api
        .invoke<undefined, { head: string | null }>(CHANNELS.PROJECT_GIT_HEAD)
        .then((r) => {
          if (live) setHead(r?.head ?? null);
        })
        .catch(() => {
          /* not a repo / git missing — leave head null */
        });
    };
    fetchHead();
    // HEAD moves when the user commits; refresh when the window regains focus.
    window.addEventListener('focus', fetchHead);
    return () => {
      live = false;
      window.removeEventListener('focus', fetchHead);
    };
  }, []);

  const rows = collectDocs(root, 'status', workspacePath);
  rows.sort(
    (a, b) => docDate(b.doc).localeCompare(docDate(a.doc)) || a.doc.path.localeCompare(b.doc.path),
  );

  return (
    <div className="flex h-full flex-col">
      <div className={PANEL_BAR}>
        <h2 className="text-sm font-semibold">Status</h2>
        <span className="text-[11px] text-muted-foreground">当前真相</span>
        {workspacePath && (
          <button
            type="button"
            title="清除工作区过滤"
            className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
            onClick={() => projectStore.openCollection('status', null)}
          >
            {workspacePath} ✕
          </button>
        )}
        <span className="text-[11px] text-muted-foreground/60">{rows.length}</span>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto h-7"
          onClick={() => openCreateDialog({ workspacePath: workspacePath ?? '.iris', type: 'status' })}
        >
          <Plus /> 新建
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {rows.map((item) => (
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
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{docDisplayTitle(item.doc)}</span>
                {item.doc.frontmatterBroken && (
                  <FileWarning className="h-3.5 w-3.5 shrink-0 text-destructive/80" />
                )}
                {item.archived && <Archive className="h-3 w-3 shrink-0 text-muted-foreground/60" />}
              </span>
              <Freshness reflects={reflectsOf(item.doc)} head={head} />
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {item.workspaceName}
              </span>
              <span className="text-right text-[11px] text-muted-foreground">
                {docDate(item.doc)}
              </span>
            </div>
          </DocContextMenu>
        ))}
        {rows.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">空</div>
        )}
      </div>
    </div>
  );
}
