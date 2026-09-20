/**
 * Raw file tree - the escape hatch. It mirrors project disk structure and only
 * overlays whether a file/directory is referenced by a workspace external.txt.
 */
import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Folder,
  Link2,
  Link2Off,
} from 'lucide-react';
import type {
  RawTreeNode,
} from '@shared/types';
import { cn } from '@renderer/lib/utils';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import { projectStore, useProject } from '@renderer/stores/project-store';
import { setDocDragData } from '@renderer/lib/doc-drag';
import { writeClipboardText } from '@renderer/lib/clipboard';
import { openProjectItem, revealProjectItem } from '@renderer/lib/shell-actions';
import { editorStore } from '@renderer/stores/editor-store';
import { useTranslation } from 'react-i18next';
import {
  addExternalPath,
  externalIdentity,
  removeExternalPath,
} from '@renderer/lib/external-actions';
import { runUserAction } from '@renderer/lib/action-runtime';
import {
  collectExternalWorkspaces,
  externalTargetKey,
  indexExternalConnections,
  type RawTreeExternalConnection,
} from '@renderer/lib/raw-tree-external';

function ItemContextMenu({
  node,
  connections,
  workspaces,
  children,
}: {
  node: RawTreeNode;
  connections: readonly RawTreeExternalConnection[];
  workspaces: ReturnType<typeof collectExternalWorkspaces>;
  children: React.ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  const absolutePath = node.absolutePath;
  const openDefault = (): void => {
    void editorStore.flushBeforeSwitch('before-external-action').then((ready) => {
      if (ready) void openProjectItem(node.path);
    });
  };
  const connect = async (workspacePath: string): Promise<void> => {
    if (!absolutePath) return;
    await runUserAction(
      { title: t('external.addFailed'), dedupeKey: `raw-tree:external:add:${workspacePath}:${node.path}` },
      async () => {
        await addExternalPath(workspacePath, absolutePath);
        await projectStore.rescan();
      },
    );
  };
  const disconnect = async (connection: RawTreeExternalConnection): Promise<void> => {
    await runUserAction(
      {
        title: t('external.removeFailed'),
        dedupeKey: `raw-tree:external:remove:${connection.workspacePath}:${connection.entry.line}`,
      },
      async () => {
        await removeExternalPath(externalIdentity(connection.workspacePath, connection.entry));
        await projectStore.rescan();
      },
    );
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
        <ContextMenuSeparator />
        {node.path !== '' && workspaces.map((workspace) => {
          const connected = connections.some((item) => item.workspacePath === workspace.path);
          return (
            <ContextMenuItem
              key={`connect:${workspace.path}`}
              disabled={connected}
              onClick={() => void connect(workspace.path).catch(() => undefined)}
            >
              {connected ? <Check /> : <Link2 />}
              <span className="max-w-52 truncate">
                {t('external.connectTo', { workspace: workspace.name })}
              </span>
            </ContextMenuItem>
          );
        })}
        {connections.map((connection) => (
          <ContextMenuItem
            key={`${connection.workspacePath}:${connection.entry.line}`}
            className="text-destructive focus:text-destructive"
            onClick={() => void disconnect(connection).catch(() => undefined)}
          >
            <Link2Off />
            {t('external.disconnectFrom', { workspace: connection.workspaceName })}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Node({
  node,
  depth,
  connectionsByPath,
  workspaces,
}: {
  node: RawTreeNode;
  depth: number;
  connectionsByPath: ReadonlyMap<string, RawTreeExternalConnection[]>;
  workspaces: ReturnType<typeof collectExternalWorkspaces>;
}): JSX.Element {
  const [open, setOpen] = useState(depth === 0);
  const { view } = useProject();
  const selectedPath = view.kind === 'doc' ? view.path : null;
  const connections = connectionsByPath.get(externalTargetKey(node.absolutePath)) ?? [];
  const connected = connections.length > 0;

  if (node.kind === 'dir') {
    const row = (
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-[13px] text-foreground/85 transition-colors hover:bg-muted/80 hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Folder className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {connected && <Link2 className="h-3 w-3 shrink-0 text-primary" aria-label="External" />}
      </button>
    );
    return (
      <div>
        <ItemContextMenu node={node} connections={connections} workspaces={workspaces}>
          {row}
        </ItemContextMenu>
        {open && node.children?.map((child) => (
          <Node
            key={child.path}
            node={child}
            depth={depth + 1}
            connectionsByPath={connectionsByPath}
            workspaces={workspaces}
          />
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
        isMd ? (selected ? 'bg-accent text-accent-foreground hover:bg-accent/90' : 'hover:bg-muted/80') : 'text-muted-foreground/60 hover:bg-muted/50 hover:text-muted-foreground',
      )}
      style={{ paddingLeft: `${depth * 12 + 8 + 16}px` }}
      aria-label={node.path}
    >
      {isMd ? (
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      )}
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {connected && <Link2 className="h-3 w-3 shrink-0 text-primary" aria-label="External" />}
    </button>
  );
  return (
    <ItemContextMenu node={node} connections={connections} workspaces={workspaces}>
      {row}
    </ItemContextMenu>
  );
}

export function RawTree({ root }: { root: RawTreeNode }): JSX.Element {
  const { scan } = useProject();
  const workspaces = collectExternalWorkspaces(scan?.root ?? null);
  const connectionsByPath = indexExternalConnections(workspaces);
  return (
    <div className="py-1">
      <Node node={root} depth={0} connectionsByPath={connectionsByPath} workspaces={workspaces} />
    </div>
  );
}
