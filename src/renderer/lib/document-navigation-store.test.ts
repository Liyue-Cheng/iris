import { beforeEach, describe, expect, it } from 'vitest';
import { documentNavigationStore } from '@renderer/stores/document-navigation-store';

describe('document navigation targets', () => {
  beforeEach(() => documentNavigationStore.clear());

  it('binds a target to document path and editor generation', () => {
    const target = documentNavigationStore.request('.iris/issue/a.md', 3, 'details');
    expect(documentNavigationStore.get()).toEqual(target);
    expect(target).toMatchObject({ path: '.iris/issue/a.md', generation: 3, fragment: 'details' });
  });

  it('does not let an older consumer clear a newer request', () => {
    const stale = documentNavigationStore.request('.iris/issue/a.md', 1, 'old');
    const latest = documentNavigationStore.request('.iris/report/b.md', 1, 'new');

    expect(documentNavigationStore.consume(stale)).toBe(false);
    expect(documentNavigationStore.get()).toEqual(latest);
    expect(documentNavigationStore.consume(latest)).toBe(true);
    expect(documentNavigationStore.get()).toBeNull();
  });
});
