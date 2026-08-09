import { describe, expect, it } from 'vitest';
import dynamicIconImports from 'lucide-react/dynamicIconImports.mjs';
import { LUCIDE_ICON_NAMES } from '@shared/lucide-icon-names';

describe('generated Lucide icon names', () => {
  it('matches the installed Lucide dynamic icon catalog', () => {
    expect(LUCIDE_ICON_NAMES).toEqual(Object.keys(dynamicIconImports).sort());
  });
});
