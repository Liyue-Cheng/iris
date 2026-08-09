import { describe, expect, it } from 'vitest';
import {
  ContextMenu,
  runAfterContextMenuClose,
} from '@renderer/components/ui/context-menu';

describe('ContextMenu', () => {
  it('defaults to non-modal menus so opening a context menu does not disturb the editor DOM', () => {
    const element = ContextMenu({});

    expect(element.props.modal).toBe(false);
  });

  it('allows callers to opt into modal behavior explicitly', () => {
    const element = ContextMenu({ modal: true });

    expect(element.props.modal).toBe(true);
  });

  it('restores editor focus after closing before dispatching an edit action', () => {
    const calls: string[] = [];
    const scheduled: Array<() => void> = [];
    const schedule = (callback: () => void): ReturnType<typeof setTimeout> => {
      scheduled.push(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };

    runAfterContextMenuClose(
      () => calls.push('focus'),
      () => calls.push('action'),
      schedule,
    );

    expect(calls).toEqual([]);
    scheduled.shift()?.();
    expect(calls).toEqual(['focus']);
    scheduled.shift()?.();
    expect(calls).toEqual(['focus', 'action']);
  });
});
