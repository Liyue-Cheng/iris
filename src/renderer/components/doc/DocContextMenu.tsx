/**
 * Shared file operations for document rows across the lens tree, collection
 * views, and raw tree. Session creation lives in the selected document's
 * right pane instead of this context menu.
 */
import type { ReactNode } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import { editorStore } from '@renderer/stores/editor-store';
import { writeClipboardText } from '@renderer/lib/clipboard';
import { openDeleteDialog } from '@renderer/components/doc/DeleteDocDialog';
import { pipeline } from '@renderer/cpu';

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
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel className="max-w-56 truncate">{docName}</ContextMenuLabel>
        <ContextMenuItem onClick={() => void writeClipboardText(docPath)}>
          复制路径
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            void editorStore
              .flushBeforeSwitch('before-external-action')
              .then((ready) =>
                ready ? pipeline.dispatch('shell.open-project-item', { path: docPath }) : undefined,
              )
          }
        >
          用默认程序打开
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            void editorStore
              .flushBeforeSwitch('before-external-action')
              .then((ready) =>
                ready ? pipeline.dispatch('shell.reveal-project-item', { path: docPath }) : undefined,
              )
          }
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
