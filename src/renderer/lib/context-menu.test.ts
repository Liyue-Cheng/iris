import { describe, expect, it } from 'vitest';
import { ContextMenu } from '@renderer/components/ui/context-menu';

describe('ContextMenu', () => {
  it('defaults to non-modal menus so opening a context menu does not disturb the editor DOM', () => {
    const element = ContextMenu({});

    expect(element.props.modal).toBe(false);
  });

  it('allows callers to opt into modal behavior explicitly', () => {
    const element = ContextMenu({ modal: true });

    expect(element.props.modal).toBe(true);
  });
});
