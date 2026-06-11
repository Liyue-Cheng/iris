/**
 * Collection view for the non-issue types: one line per doc, from简
 * (软件定义书 §5 — 其余类型从简). report 列表按日期倒序即一份时间线。
 */
import { Archive, FileWarning, Plus } from 'lucide-react';
import type { DocType, IrisWorkspace } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { collectDocs, docDate } from '@renderer/lib/collect-docs';
import { docDisplayTitle } from '@renderer/lib/doc-utils';
import { projectStore } from '@renderer/stores/project-store';
import { openCreateDialog } from '@renderer/components/doc/CreateDocDialog';
import { Button } from '@renderer/components/ui/button';

const TYPE_TITLE: Record<DocType, string> = {
  status: 'Status — 当前真相',
  issue: 'Issue',
  report: 'Report — 冻结的过去',
  misc: 'Misc — 草稿',
};

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
      <div className="flex shrink-0 items-center gap-2 border-b bg-card/30 px-4 py-2">
        <h2 className="text-sm font-semibold">
          {TYPE_TITLE[type]}
          {workspacePath && (
            <button
              type="button"
              title="清除工作区过滤"
              className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground hover:bg-accent"
              onClick={() => projectStore.openCollection(type, null)}
            >
              {workspacePath} ✕
            </button>
          )}
        </h2>
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

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {rows.map((item) => (
          <button
            key={item.doc.path}
            type="button"
            onClick={() => void projectStore.selectDoc(item.doc.path)}
            className={cn(
              'flex w-full items-center gap-2 px-4 py-1.5 text-left text-[13px] hover:bg-muted/60',
              item.archived && 'opacity-50',
            )}
            title={item.doc.path}
          >
            <span className="truncate">{docDisplayTitle(item.doc)}</span>
            {item.doc.frontmatterBroken && (
              <FileWarning className="h-3.5 w-3.5 shrink-0 text-destructive/80" />
            )}
            {item.archived && <Archive className="h-3 w-3 shrink-0 text-muted-foreground/60" />}
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
              {item.workspaceName}
            </span>
            <span className="w-24 shrink-0 text-right text-[11px] text-muted-foreground">
              {docDate(item.doc)}
            </span>
          </button>
        ))}
        {rows.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">空</div>
        )}
      </div>
    </div>
  );
}
