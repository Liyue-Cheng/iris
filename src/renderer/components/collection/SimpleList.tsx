/**
 * Collection view for the remaining从简 type: misc (人类草稿). One grid row
 * per doc, sharing the row vocabulary with the other panels so switching
 * between them doesn't shift the layout (软件定义书 §5 — 其余类型从简).
 */
import { Archive, FileWarning, Plus } from 'lucide-react';
import type { DocType, IrisWorkspace } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { collectDocs, docDate } from '@renderer/lib/collect-docs';
import { docDisplayTitle } from '@renderer/lib/doc-utils';
import { setDocDragData } from '@renderer/lib/doc-drag';
import { projectStore } from '@renderer/stores/project-store';
import { openCreateDialog } from '@renderer/components/doc/CreateDocDialog';
import { DocContextMenu } from '@renderer/components/doc/DocContextMenu';
import { Button } from '@renderer/components/ui/button';
import { PANEL_BAR, ROW_BASE } from './parts/layout';

const TYPE_TITLE: Record<DocType, string> = {
  status: 'Status',
  issue: 'Issue',
  report: 'Report',
  misc: 'Misc — 草稿',
};

const GRID = 'minmax(0,1fr) minmax(0,96px) 76px';

export function SimpleList({
  root,
  type,
  workspacePath,
}: {
  root: IrisWorkspace;
  type: DocType;
  workspacePath: string | null;
}): JSX.Element {
  const rows = collectDocs(root, type, workspacePath);
  rows.sort(
    (a, b) => docDate(b.doc).localeCompare(docDate(a.doc)) || a.doc.path.localeCompare(b.doc.path),
  );

  return (
    <div className="flex h-full flex-col">
      <div className={PANEL_BAR}>
        <h2 className="text-sm font-semibold">{TYPE_TITLE[type]}</h2>
        {workspacePath && (
          <button
            type="button"
            title="清除工作区过滤"
            className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
            onClick={() => projectStore.openCollection(type, null)}
          >
            {workspacePath} ✕
          </button>
        )}
        <span className="text-[11px] text-muted-foreground">{rows.length}</span>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto h-7"
          onClick={() => openCreateDialog({ workspacePath: workspacePath ?? '.iris', type })}
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
