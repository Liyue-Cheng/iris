/**
 * Raw file tree — the escape hatch (软件定义书 §5: 裸文件树是 toggle 出的
 * 逃生舱). Shows the complete project exactly as it sits on disk, non-md files included.
 * Markdown files are clickable into the preview; everything else is inert.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, File, Folder } from 'lucide-react';
import type { RawTreeNode } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuTrigger } from '@renderer/components/ui/context-menu';
import { projectStore, useProject } from '@renderer/stores/project-store';
import { setDocDragData } from '@renderer/lib/doc-drag';
import { writeClipboardText } from '@renderer/lib/clipboard';
import { openProjectItem, revealProjectItem } from '@renderer/lib/shell-actions';
import { editorStore } from '@renderer/stores/editor-store';
import { useTranslation } from 'react-i18next';
import { lensPrefs } from '@renderer/stores/lens-prefs';

function FileContextMenu({
  node,
  externalWorkspacePath,
  children,
}: {
  node: RawTreeNode;
  externalWorkspacePath: string | null;
  children: React.ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  const openDefault = (): void => {
    void editorStore.flushBeforeSwitch('before-external-action').then((ready) => {
      if (ready) void openProjectItem(node.path);
    });
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel className="max-w-56 truncate">{node.name}</ContextMenuLabel>
        <ContextMenuItem onClick={() => void writeClipboardText(node.path)}>
          {t('common.copyPath')}
        </ContextMenuItem>
        <ContextMenuItem onClick={openDefault}>{t('common.openDefault')}</ContextMenuItem>
        <ContextMenuItem onClick={() => void revealProjectItem(node.path)}>
          {t('common.reveal')}
        </ContextMenuItem>
        {externalWorkspacePath !== null && (
          <ContextMenuItem
            onClick={() => {
              projectStore.showLens();
              lensPrefs.revealExternal(externalWorkspacePath);
            }}
          >
            {t('external.manage')}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Node({
  node,
  depth,
  externalManifests,
}: {
  node: RawTreeNode;
  depth: number;
  externalManifests: ReadonlyMap<string, string>;
}): JSX.Element {
  // Keep the project root visible on entry; nested directories stay collapsed.
  const [open, setOpen] = useState(depth === 0);
  const { view } = useProject();
  const selectedPath = view.kind === 'doc' ? view.path : null;

  if (node.kind === 'dir') {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-[13px] text-foreground/85 transition-colors hover:bg-muted/80 hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <Folder className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map((c) => (
          <Node key={c.path} node={c} depth={depth + 1} externalManifests={externalManifests} />
        ))}
      </div>
    );
  }

  const isMd = node.name.toLowerCase().endsWith('.md');
  const selected = selectedPath === node.path;
  const row = (
    <button
      type="button"
      draggable
      onDragStart={(event) => setDocDragData(event.dataTransfer, node.path)}
      onClick={() => void openProjectItem(node.path)}
      className={cn(
        'flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-[13px] transition-colors focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none',
        isMd ? (selected ? 'bg-accent text-accent-foreground hover:bg-accent/90' : 'hover:bg-muted/80') : 'cursor-default text-muted-foreground/60 hover:bg-muted/50 hover:text-muted-foreground',
      )}
      style={{ paddingLeft: `${depth * 12 + 8 + 16}px` }}
      aria-label={node.path}
    >
      {isMd ? (
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      )}
      <span className="truncate">{node.name}</span>
    </button>
  );
  return (
    <FileContextMenu node={node} externalWorkspacePath={externalManifests.get(node.path) ?? null}>
      {row}
    </FileContextMenu>
  );
}

export function RawTree({ root }: { root: RawTreeNode }): JSX.Element {
  const { scan } = useProject();
  const externalManifests = new Map<string, string>();
  const collect = (workspace: NonNullable<typeof scan>['root']): void => {
    if (!workspace) return;
    externalManifests.set(workspace.external.manifestPath, workspace.path);
    workspace.children.forEach(collect);
  };
  collect(scan?.root ?? null);
  return (
    <div className="py-1">
      <Node node={root} depth={0} externalManifests={externalManifests} />
    </div>
  );
}
