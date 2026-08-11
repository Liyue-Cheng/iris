import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectScope } from '@shared/types';
import { healthStore } from '@renderer/stores/health-store';

const scopeA: ProjectScope = { root: 'C:/a', generation: 1 };
const scopeB: ProjectScope = { root: 'C:/b', generation: 2 };

afterEach(() => healthStore.clear());

describe('health store', () => {
  it('deduplicates failures and isolates project generations', () => {
    healthStore.degrade({
      key: 'project-projection',
      domain: 'project-projection',
      cause: new Error('first'),
      scope: scopeA,
    });
    healthStore.degrade({
      key: 'project-projection',
      domain: 'project-projection',
      cause: new Error('second'),
      scope: scopeA,
    });

    expect(healthStore.get()).toHaveLength(1);
    expect(healthStore.get()[0]).toMatchObject({ occurrences: 2 });
    healthStore.resetForScope(scopeB);
    expect(healthStore.get()).toHaveLength(0);
  });

  it('clears a recovered issue after retry', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    healthStore.degrade({
      key: 'session-projection',
      domain: 'session-projection',
      cause: new Error('stale'),
      scope: scopeA,
      retry,
    });

    await healthStore.retry(healthStore.get()[0]!);
    expect(retry).toHaveBeenCalledOnce();
    expect(healthStore.get()).toHaveLength(0);
  });
});
