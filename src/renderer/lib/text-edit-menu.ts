/**
 * State for the native text-control context menu.
 *
 * Electron shows no context menu of its own, and Radix's ContextMenuTrigger
 * suppresses the browser's default `contextmenu` event, so a bare
 * <input>/<textarea> used to swallow right-click entirely. The menu itself is
 * `components/ui/text-edit-context-menu.tsx`; this module keeps the pure part —
 * snapshotting the caret/selection and deciding which edit commands are
 * available — DOM-free so it can be unit tested.
 */
import type { WindowEditAction } from '@shared/protocol';

/** Every command the text edit menu can dispatch. */
export type TextEditAction = WindowEditAction;

/** The slice of a text control the menu needs; keeps tests free of a DOM. */
export interface TextEditTarget {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

/** A text control the menu can drive: anything with a caret and focus(). */
export interface TextEditControl extends TextEditTarget {
  focus: () => void;
  setSelectionRange: (start: number, end: number) => void;
}

/** Caret/selection snapshot taken when the menu opens. */
export interface TextEditSelection {
  start: number;
  end: number;
  hasSelection: boolean;
  hasText: boolean;
}

export function emptyTextEditSelection(): TextEditSelection {
  return { start: 0, end: 0, hasSelection: false, hasText: false };
}

/**
 * Snapshot the caret/selection at menu-open time. The menu steals focus while
 * it is open, so this snapshot is also the range the caller restores before
 * dispatching the edit command.
 */
export function readTextEditSelection(target: TextEditTarget | null): TextEditSelection {
  if (!target) return emptyTextEditSelection();
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? start;
  return {
    start,
    end,
    hasSelection: end > start,
    hasText: target.value.length > 0,
  };
}

/**
 * Which menu items should render disabled.
 *
 * Cut/copy need a selection, so their state is exact. Select-all needs any
 * content at all; an empty field has nothing to select, which is the one case
 * we can rule out with certainty. Paste depends only on the clipboard, which
 * the renderer cannot inspect, so it stays enabled.
 */
export function isTextEditActionDisabled(
  action: TextEditAction,
  selection: TextEditSelection,
): boolean {
  switch (action) {
    case 'cut':
    case 'copy':
      return !selection.hasSelection;
    case 'selectAll':
      return !selection.hasText;
    case 'paste':
      return false;
  }
}
