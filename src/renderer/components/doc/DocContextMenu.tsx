/**
 * Shared file operations for document rows across the lens tree, collection
 * views, and raw tree. Session creation lives in the selected document's
 * right pane instead of this context menu.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
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
  onOpenInDefaultView,
  children,
}: {
  /** Project-root-relative path (what session.open and shell:reveal expect). */
  docPath: string;
  docName: string;
  onOpenInDefaultView?: () => void;
  children: ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel className="max-w-56 truncate">{docName}</ContextMenuLabel>
        <ContextMenuItem onClick={() => void writeClipboardText(docPath)}>
          {t('common.copyPath')}
        </ContextMenuItem>
        {onOpenInDefaultView && (
          <ContextMenuItem onClick={onOpenInDefaultView}>
            {t('editor.openInDefaultView')}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onClick={() =>
            void editorStore
              .flushBeforeSwitch('before-external-action')
              .then((ready) =>
                ready ? pipeline.dispatch('shell.open-project-item', { path: docPath }) : undefined,
              )
          }
        >
          {t('common.openDefault')}
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
          {t('common.reveal')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => openDeleteDialog({ docPath, docName })}
        >
          {t('common.deleteFile')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
