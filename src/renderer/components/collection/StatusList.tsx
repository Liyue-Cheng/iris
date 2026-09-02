/**
 * Status panel — "当前真相". Status documents are maintained current views;
 * their collection is intentionally independent of Git metadata.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, FileWarning, Plus } from 'lucide-react';
import type { IrisWorkspace } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { collectDocs, docDate } from '@renderer/lib/collect-docs';
import { docDisplayTitle } from '@renderer/lib/doc-utils';
import { setDocDragData } from '@renderer/lib/doc-drag';
import { projectStore, useProject } from '@renderer/stores/project-store';
import { openCreateDialog } from '@renderer/components/doc/CreateDocDialog';
import { DocContextMenu } from '@renderer/components/doc/DocContextMenu';
import { Button } from '@renderer/components/ui/button';
import { PANEL_BAR, ROW_BASE } from './parts/layout';

const GRID = 'minmax(0,1fr) minmax(0,96px) 76px';
const statusListScroll = new Map<string, number>();

export function StatusList({
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
  const listRef = useRef<HTMLDivElement | null>(null);
  const memoryKey = `${scope?.root ?? ''}\u0000${workspacePath ?? ''}`;

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const frame = requestAnimationFrame(() => {
      list.scrollTop = statusListScroll.get(memoryKey) ?? 0;
    });
    return () => {
      cancelAnimationFrame(frame);
      statusListScroll.set(memoryKey, list.scrollTop);
    };
  }, [memoryKey]);

  const rows = collectDocs(root, 'status', workspacePath);
  rows.sort(
    (a, b) => docDate(b.doc).localeCompare(docDate(a.doc)) || a.doc.path.localeCompare(b.doc.path),
  );

  return (
    <div className="flex h-full flex-col">
      <div className={PANEL_BAR}>
        <h2 className="text-sm font-semibold">status</h2>
        <span className="text-[11px] text-muted-foreground">{t('collection.currentTruth')}</span>
        {workspacePath && (
          <button
            type="button"
            title={t('collection.clearWorkspaceFilter')}
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
          onClick={() =>
            openCreateDialog({
              workspacePath: workspacePath ?? '.iris',
              type: 'status',
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
        onScroll={(event) => statusListScroll.set(memoryKey, event.currentTarget.scrollTop)}
      >
        {rows.map((item) => (
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
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">{t('common.empty')}</div>
        )}
      </div>
    </div>
  );
}
