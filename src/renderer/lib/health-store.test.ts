import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectScope } from '@shared/types';
import { healthStore } from '@renderer/stores/health-store';
import { projectScopeState } from '@renderer/stores/project-scope-state';

const scopeA: ProjectScope = { root: 'C:/a', generation: 1 };
const scopeB: ProjectScope = { root: 'C:/b', generation: 2 };

beforeEach(() => projectScopeState.set(scopeA));
afterEach(() => { healthStore.clear(); projectScopeState.set(null); });

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
    const retry = vi.fn(async () => { healthStore.resolve('session-projection', scopeA); });
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

  it('requires an actual health result rather than a normally returned callback', async () => {
    healthStore.degrade({ key: 'git-projection', domain: 'git-projection', cause: new Error('failed'), scope: scopeA,
      retry: async () => undefined });
    await healthStore.retry(healthStore.get()[0]!);
    expect(healthStore.get()).toMatchObject([{ state: 'degraded', error: { message: 'failed' } }]);
  });

  it('retains the original custom key and enables retry after a rejected callback', async () => {
    healthStore.degrade({ key: 'iris-agent-projection', domain: 'session-projection', cause: new Error('failed'), scope: scopeA,
      retry: async () => { throw new Error('again'); } });
    await healthStore.retry(healthStore.get()[0]!);
    expect(healthStore.get()).toMatchObject([{
      key: 'C:/a:1:iris-agent-projection', state: 'degraded', error: { message: 'again' },
    }]);
  });

  it('does not recreate a retired issue when its retry rejects after a project switch', async () => {
    let fail!: (cause: Error) => void;
    const pending = new Promise<void>((_, reject) => { fail = reject; });
    const retry = vi.fn(() => pending);
    healthStore.degrade({ key: 'project-projection', domain: 'project-projection', cause: new Error('failed'), scope: scopeA, retry });
    const old = healthStore.get()[0]!;
    const work = healthStore.retry(old);
    projectScopeState.set(scopeB);
    fail(new Error('old failure'));
    await work;
    await healthStore.retry(old);
    expect(healthStore.get()).toHaveLength(0);
    expect(retry).toHaveBeenCalledOnce();
  });

  it('removes an obsolete repair callback when the latest failure has none', () => {
    healthStore.degrade({ key: 'prompt-projection', domain: 'prompt-projection', cause: new Error('repairable'), scope: scopeA,
      retry: async () => undefined });
    healthStore.degrade({ key: 'prompt-projection', domain: 'prompt-projection', cause: new Error('conflict'), scope: scopeA });
    expect(healthStore.get()[0]!.retry).toBeUndefined();
  });
});
