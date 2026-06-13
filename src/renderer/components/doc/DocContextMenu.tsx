/**
 * Right-click menu for a document row — the core gesture's canonical entry
 * (软件定义书 §4: 选中文档 → 右键 → 用 X 打开). One agent entry per
 * settings.agents, plus reveal-in-explorer. Wrap any row-like trigger;
 * every doc surface (lens tree, collection views, raw tree) shares this.
 */
import type { ReactNode } from 'react';
import { CHANNELS } from '@shared/protocol';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import { useSettings } from '@renderer/stores/settings-store';
import { openSession } from '@renderer/lib/session-actions';
import { openDeleteDialog } from '@renderer/components/doc/DeleteDocDialog';

export function DocContextMenu({
  docPath,
  docName,
  children,
}: {
  /** Project-root-relative path (what session.open and shell:reveal expect). */
  docPath: string;
  docName: string;
  children: ReactNode;
}): JSX.Element {
  const settings = useSettings();
  const agents = settings?.agents ?? [];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel className="max-w-56 truncate">{docName}</ContextMenuLabel>
        {agents.map((a) => (
          <ContextMenuItem key={a.id} onClick={() => void openSession(docPath, a.id)}>
            用 {a.label} 打开
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => void window.api.invoke(CHANNELS.SHELL_REVEAL, { path: docPath })}
        >
          在资源管理器中显示
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => openDeleteDialog({ docPath, docName })}
        >
          删除文件…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
