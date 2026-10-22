/**
 * Project file tree with sibling sorting, path filtering and workspace external links.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
  Link2,
  Link2Off,
} from 'lucide-react';
import type {
  RawTreeNode,
} from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
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
import './raw-tree.css';
import { useLensPrefs } from '@renderer/stores/lens-prefs';
import { normalizeFileFilter, projectRawTree } from '@renderer/lib/raw-tree-view';

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

function fileIcon(name: string): typeof File {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'mdx', 'txt', 'log', 'rst'].includes(extension)) return FileText;
  if (['json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'ini'].includes(extension)) return FileJson2;
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'html', 'css', 'scss', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'sh', 'ps1'].includes(extension)) return FileCode2;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif', 'bmp'].includes(extension)) return FileImage;
  if (['zip', 'gz', 'tar', '7z', 'rar'].includes(extension)) return FileArchive;
  return File;
}

function Node({
  node,
  depth,
  connectionsByPath,
  workspaces,
  selectedPath,
  onSelect,
  expandedPaths,
  defaultExpanded,
  onToggle,
}: {
  node: RawTreeNode;
  depth: number;
  connectionsByPath: ReadonlyMap<string, RawTreeExternalConnection[]>;
  workspaces: ReturnType<typeof collectExternalWorkspaces>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  expandedPaths: ReadonlyMap<string, boolean>;
  defaultExpanded: boolean;
  onToggle: (path: string, open: boolean) => void;
}): JSX.Element {
  const open = expandedPaths.get(node.path) ?? (defaultExpanded || depth === 0);
  const connections = connectionsByPath.get(externalTargetKey(node.absolutePath)) ?? [];
  const directory = node.kind === 'dir';
  const selected = selectedPath === node.path;
  const activeBranch = selectedPath !== null && (
    node.path === '' || selected || selectedPath.startsWith(`${node.path}/`)
  );
  const Icon = directory ? (open ? FolderOpen : Folder) : fileIcon(node.name);
  const connectionHint = connections.length > 0
    ? `External: ${connections.map((connection) => connection.workspaceName).join(', ')}`
    : '';
  const fullPath = node.absolutePath || node.path || node.name;
  const row = (
    <button
      type="button"
      draggable={!directory}
      onDragStart={directory ? undefined : (event) => {
        onSelect(node.path);
        setDocDragData(event.dataTransfer, node.path);
      }}
      onClick={() => {
        onSelect(node.path);
        if (directory) onToggle(node.path, !open);
        else void openProjectItem(node.path);
      }}
      onContextMenu={() => onSelect(node.path)}
      className={cn('raw-tree-row', depth === 0 && 'raw-tree-root')}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      data-selected={selected}
      aria-current={selected ? 'true' : undefined}
      aria-expanded={directory ? open : undefined}
      aria-label={node.path || node.name}
    >
      <span className="raw-tree-twistie" aria-hidden="true">
        {directory && (open ? <ChevronDown /> : <ChevronRight />)}
      </span>
      <Icon className="raw-tree-icon" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {connections.length > 0 && (
        <span className="raw-tree-connection">
          <Link2 className="size-3" aria-label={connectionHint} />
        </span>
      )}
    </button>
  );
  return (
    <div>
      <Tooltip>
        <ItemContextMenu node={node} connections={connections} workspaces={workspaces}>
          <TooltipTrigger asChild>{row}</TooltipTrigger>
        </ItemContextMenu>
        <TooltipContent side="right" className="max-w-sm whitespace-pre-wrap break-all">
          {connectionHint ? `${fullPath}\n${connectionHint}` : fullPath}
        </TooltipContent>
      </Tooltip>
      {directory && open && !!node.children?.length && (
        <div
          className="raw-tree-children"
          data-active={activeBranch}
          style={{ '--raw-tree-guide-left': `${depth * 12 + 12}px` } as CSSProperties}
        >
          {node.children.map((child) => (
            <Node
              key={child.path}
              node={child}
              depth={depth + 1}
              connectionsByPath={connectionsByPath}
              workspaces={workspaces}
              selectedPath={selectedPath}
              onSelect={onSelect}
              expandedPaths={expandedPaths}
              defaultExpanded={defaultExpanded}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function RawTree({ root }: { root: RawTreeNode }): JSX.Element {
  const { t, i18n } = useTranslation();
  const { scan } = useProject();
  const { sort, filter } = useLensPrefs();
  const query = normalizeFileFilter(filter);
  const visibleRoot = useMemo(() => projectRawTree(root, sort, query), [root, sort, query, i18n.resolvedLanguage]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [filterExpansion, setFilterExpansion] = useState({ query, paths: new Map<string, boolean>() });
  const filteredPaths = filterExpansion.query === query ? filterExpansion.paths : new Map<string, boolean>();
  // Reset search-only collapse overrides when the query changes; ordinary expansion is preserved.
  if (filterExpansion.query !== query) setFilterExpansion({ query, paths: filteredPaths });
  const onToggle = (path: string, open: boolean): void => {
    if (query) setFilterExpansion({ query, paths: new Map(filteredPaths).set(path, open) });
    else setExpandedPaths((previous) => new Map(previous).set(path, open));
  };
  const workspaces = collectExternalWorkspaces(scan?.root ?? null);
  const connectionsByPath = indexExternalConnections(workspaces);
  return (
    <div className="raw-tree" aria-label={t('layout.filesTitle')}>
      <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
        {t('layout.filesTitle')}
      </div>
      {visibleRoot ? (
        <Node
          node={visibleRoot}
          depth={0}
          connectionsByPath={connectionsByPath}
          workspaces={workspaces}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
          expandedPaths={query ? filteredPaths : expandedPaths}
          defaultExpanded={query !== ''}
          onToggle={onToggle}
        />
      ) : (
        <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
          {t('layout.noMatchingFiles')}
        </p>
      )}
    </div>
  );
}
