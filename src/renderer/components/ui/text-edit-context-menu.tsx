/**
 * Context menu for native text controls (<input> / <textarea>).
 *
 * Iris draws its own menus and never opens an Electron-native one, and Radix's
 * ContextMenuTrigger swallows the browser's default `contextmenu` event — so
 * before this wrapper, right-clicking a plain text control did nothing at all.
 * Here it gets the standard edit menu: cut/copy/paste and select-all.
 *
 * Commands are dispatched through WINDOW_EDIT_ACTION, which runs the webContents
 * edit command on the focused element — the same route the Markdown editor
 * uses. Keeping Chromium in charge of cut/copy/paste and the undo stack avoids
 * re-implementing clipboard semantics (rich text, line endings) on top of React
 * state.
 */
import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { CHANNELS } from '@shared/protocol';
import { runUserAction } from '@renderer/lib/action-runtime';
import {
  emptyTextEditSelection,
  isTextEditActionDisabled,
  readTextEditSelection,
  type TextEditAction,
  type TextEditControl,
  type TextEditSelection,
} from '@renderer/lib/text-edit-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  runAfterContextMenuClose,
} from '@renderer/components/ui/context-menu';

export function TextEditContextMenu({
  targetRef,
  disabled = false,
  children,
}: {
  /** The control the menu edits; the caller also attaches it to the element. */
  targetRef: RefObject<TextEditControl | null>;
  /** Set while the control itself is disabled, so right-click stays inert. */
  disabled?: boolean;
  children: ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  const selectionRef = useRef<TextEditSelection>(emptyTextEditSelection());
  const [selection, setSelection] = useState<TextEditSelection>(emptyTextEditSelection);

  // Radix suppresses the native `contextmenu`, so the caret cannot move once
  // the menu opens; snapshot the range now and reuse it to restore focus (and
  // the exact caret/selection) before dispatching a command.
  const handleOpenChange = useCallback(
    (open: boolean): void => {
      if (!open) return;
      const snapshot = readTextEditSelection(targetRef.current);
      selectionRef.current = snapshot;
      setSelection(snapshot);
    },
    [targetRef],
  );

  const runEditAction = useCallback(
    (action: TextEditAction): void => {
      // Defensive: `data-disabled:pointer-events-none` already blocks clicks,
      // but never dispatch a command the snapshot says is unavailable.
      if (isTextEditActionDisabled(action, selectionRef.current)) return;
      const target = targetRef.current;
      const snapshot = selectionRef.current;
      runAfterContextMenuClose(
        () => {
          if (!target) return;
          target.focus();
          try {
            target.setSelectionRange(snapshot.start, snapshot.end);
          } catch {
            // Input types such as number/date reject explicit ranges; the
            // command still runs against whatever Chromium considers focused.
          }
        },
        () => {
          void runUserAction(
            { title: t('errors.editActionFailed'), dedupeKey: `window:edit:${action}` },
            () => window.api.invoke(CHANNELS.WINDOW_EDIT_ACTION, { action }),
          );
        },
      );
    },
    [t, targetRef],
  );

  const renderItem = (action: TextEditAction, label: string): JSX.Element => (
    <ContextMenuItem
      disabled={isTextEditActionDisabled(action, selection)}
      onClick={() => runEditAction(action)}
    >
      {label}
    </ContextMenuItem>
  );

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild disabled={disabled}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {renderItem('cut', t('common.cut'))}
        {renderItem('copy', t('common.copy'))}
        {renderItem('paste', t('common.paste'))}
        <ContextMenuSeparator />
        {renderItem('selectAll', t('common.selectAll'))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
