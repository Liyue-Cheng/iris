import { describe, expect, it } from 'vitest';
import { DropdownMenu } from '@renderer/components/ui/dropdown-menu';

describe('DropdownMenu', () => {
  it('defaults to non-modal menus so opening a menu does not scroll-lock the editor', () => {
    const element = DropdownMenu({});

    expect(element.props.modal).toBe(false);
  });

  it('allows callers to opt into modal behavior explicitly', () => {
    const element = DropdownMenu({ modal: true });

    expect(element.props.modal).toBe(true);
  });
});
