// Exercise real stores/actions with controlled IPC response ordering.
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { healthStore } from '@renderer/stores/health-store';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import { hydrateSessions } from '@renderer/stores/session-store';
import { hydrateIrisAgentSessions } from '@renderer/stores/iris-agent-store';
import { irisAgentStore } from '@renderer/stores/iris-agent-store';
import type { IrisAgentSessionInfo } from '@shared/types';
import { runUserAction } from '@renderer/lib/action-runtime';
import { getNotifications, clearNotifications } from '@renderer/stores/notification-store';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), invoke: vi.fn() }));
vi.mock('@renderer/cpu', () => ({ pipeline: { dispatch: mocks.dispatch } }));
vi.mock('@renderer/i18n', () => ({ translate: (key: string) => key }));
vi.mock('@renderer/components/ui/confirm-dialog', () => ({
  alertDialog: vi.fn(), confirmDialog: vi.fn().mockResolvedValue(false),
}));

const scopeA = { root: 'E:/audit/a', generation: 101 };
const scopeB = { root: 'E:/audit/b', generation: 102 };
let projectStore: typeof import('@renderer/stores/project-store').projectStore;
let gitStore: typeof import('@renderer/stores/git-store').gitStore;
let projectActions: typeof import('@renderer/lib/project-actions');
let agentActions: typeof import('@renderer/lib/iris-agent-actions');

function opened(scope = scopeA) {
  projectStore.handleOpened({ scope, sessions: [], scan: {
    projectRoot: scope.root, projectName: 'audit', hasIris: true, scannedAt: 1,
    root: { path: '.iris', name: 'audit', docs: [], children: [],
      external: { workspacePath: '.iris', manifestPath: '.iris/external.txt', exists: false, entries: [], diagnostics: [] } },
  } });
}
function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const stale = () => Object.assign(new Error('stale project scope'), { domain: 'project', code: 'StaleProjectScope' });
const options = { title: 'operation failed', dedupeKey: 'audit:operation' };

beforeAll(async () => {
  vi.stubGlobal('window', { api: { invoke: mocks.invoke, on: vi.fn(() => () => {}) },
    setInterval, clearInterval, addEventListener: vi.fn() });
  ({ projectStore } = await import('@renderer/stores/project-store'));
  ({ gitStore } = await import('@renderer/stores/git-store'));
  projectActions = await import('@renderer/lib/project-actions');
  agentActions = await import('@renderer/lib/iris-agent-actions');
});
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.dispatch.mockReset();
  healthStore.clear(); clearNotifications();
  opened(); projectScopeState.setSwitching(false); gitStore.resetForTests();
  irisAgentStore.reset([{
    id: 'session', projectRoot: scopeA.root, projectGeneration: scopeA.generation,
    revision: 1, state: 'ready',
  } as IrisAgentSessionInfo], scopeA);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { healthStore.clear(); clearNotifications(); vi.restoreAllMocks(); });

describe('error ownership and recovery', () => {
  for (const [name, start] of [
    ['terminal list', () => hydrateSessions()],
    ['Agent list', () => hydrateIrisAgentSessions()],
    ['project scan', () => projectStore.rescan()],
    ['raw tree', () => projectStore.refreshRawTree()],
    ['prompt health', () => projectActions.refreshPromptProjectionHealth()],
  ] as const) {
    it(`${name}: discards a late failure from A after B opens`, async () => {
      const pending = deferred(); mocks.invoke.mockReturnValueOnce(pending.promise);
      const work = start();
      expect(mocks.invoke).toHaveBeenCalledOnce();
      opened(scopeB); expect(healthStore.get()).toHaveLength(0);
      pending.reject(stale()); await work;
      expect(projectScopeState.get()).toEqual(scopeB);
      expect(healthStore.get()).toHaveLength(0);
    });
  }

  it('negative control: Git refresh discards a late failure from A', async () => {
    const pending = deferred(); mocks.invoke.mockReturnValueOnce(pending.promise);
    const work = gitStore.refresh(); opened(scopeB); gitStore.reset();
    pending.reject(stale()); await work;
    expect(healthStore.get()).toHaveLength(0);
    expect(gitStore.get().error).toBeNull();
  });

  for (const [name, start] of [
    ['terminal list', () => hydrateSessions()],
    ['Agent list', () => hydrateIrisAgentSessions()],
  ] as const) {
    it(`${name}: preserves recovery when an older list fails after a newer list succeeds`, async () => {
      const older = deferred(); const newer = deferred();
      mocks.invoke.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      const work1 = start(); const work2 = start();
      newer.resolve({ scope: scopeA, sessions: [] }); await work2;
      expect(healthStore.get()).toHaveLength(0);
      older.reject(new Error('older list failed')); await work1;
      expect(healthStore.get()).toHaveLength(0);
    });

    it(`${name}: an old successful list cannot clear a newer failure`, async () => {
      const older = deferred(); const newer = deferred();
      mocks.invoke.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      const work1 = start(); const work2 = start();
      newer.reject(new Error('current read failed')); await work2;
      older.resolve({ scope: scopeA, sessions: [] }); await work1;
      expect(healthStore.get()).toMatchObject([{ state: 'degraded', error: { message: 'current read failed' } }]);
    });
  }

  it('task cancellation discards a lifecycle error for an old project in B', async () => {
    const pending = deferred(); mocks.invoke.mockReturnValueOnce(pending.promise);
    const work = agentActions.cancelIrisAgentTask('old-session', 'old-task');
    opened(scopeB); pending.reject(stale());
    expect(await work).toBe(false);
    expect(getNotifications()).toHaveLength(0);
  });

  it('does not open an Agent in the new project after waiting for the old editor to flush', async () => {
    const { editorStore } = await import('@renderer/stores/editor-store');
    const pending = deferred();
    vi.spyOn(editorStore, 'flushBeforeSwitch').mockReturnValueOnce(pending.promise as Promise<boolean>);
    const work = agentActions.openIrisAgent({ kind: 'workspace', path: '.iris' });
    opened(scopeB); pending.resolve(true);
    expect(await work).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(getNotifications()).toHaveLength(0);
  });

  it('discards a pending command failure after its Agent session is removed', async () => {
    const pending = deferred(); mocks.invoke.mockReturnValueOnce(pending.promise);
    const work = agentActions.cancelIrisAgentTask('session', 'task');
    irisAgentStore.handleDestroyed('session');
    pending.reject(new Error('session no longer available'));
    expect(await work).toBe(false);
    expect(getNotifications()).toHaveLength(0);
  });

  it('a later nonretryable error removes the earlier retry closure and incident', async () => {
    const earlier = vi.fn().mockRejectedValue(Object.assign(new Error('old failure'), {
      retryable: true, incidentId: 'old-incident', domain: 'session',
    }));
    const newer = vi.fn().mockRejectedValue(Object.assign(new Error('new failure'), {
      retryable: false, domain: 'session',
    }));
    await runUserAction(options, earlier);
    const oldRetry = getNotifications()[0]!.action!.run;
    await runUserAction(options, newer);
    expect(getNotifications()).toMatchObject([{ message: 'new failure' }]);
    expect(getNotifications()[0]!.incidentId).toBeUndefined();
    expect(getNotifications()[0]!.action).toBeUndefined();
    oldRetry();
    expect(earlier).toHaveBeenCalledOnce();
    expect(newer).toHaveBeenCalledOnce();
  });

  it('a confirmed successful repeat clears the previous failure notice', async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce('ok');
    await runUserAction(options, operation);
    expect(await runUserAction(options, operation)).toEqual({ status: 'ok', value: 'ok' });
    expect(getNotifications()).toHaveLength(0);
  });

  it('discards an older failure after a newer success of the same state update', async () => {
    const old = deferred(); const newer = deferred();
    const work1 = runUserAction(options, () => old.promise);
    const work2 = runUserAction(options, () => newer.promise);
    newer.resolve('ok'); await work2; old.reject(new Error('old failure')); await work1;
    expect(getNotifications()).toHaveLength(0);
  });

  it('Git health retry preserves the banner when the refresh fails again', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('first Git failure'))
      .mockRejectedValueOnce(new Error('Git still failing'));
    await gitStore.refresh(); expect(healthStore.get()).toHaveLength(1);
    await healthStore.retry(healthStore.get()[0]!);
    expect(gitStore.get().error).toBe('Git still failing');
    expect(healthStore.get()).toMatchObject([{ state: 'degraded', error: { message: 'Git still failing' } }]);
  });

  for (const [name, start, key, domain] of [
    ['Agent', () => hydrateIrisAgentSessions(), 'iris-agent-projection', 'session-projection'],
    ['raw tree', () => projectStore.refreshRawTree(), 'project-raw-tree', 'project-projection'],
  ] as const) {
    it(`${name} retry failure updates the original key and enables another retry`, async () => {
      mocks.invoke.mockRejectedValueOnce(new Error('first failure')).mockRejectedValueOnce(new Error('still failing'));
      await start(); await healthStore.retry(healthStore.get()[0]!);
      expect(healthStore.get()).toMatchObject([
        { key: `${scopeA.root}:${scopeA.generation}:${key}`, domain, state: 'degraded', error: { message: 'still failing' } },
      ]);
    });
  }

  it('a successful callback cannot erase a newer degradation of the same service', async () => {
    const pending = deferred();
    healthStore.degrade({ key: 'session-projection', domain: 'session-projection', cause: new Error('first'), scope: scopeA,
      retry: () => pending.promise as Promise<void> });
    const retrying = healthStore.retry(healthStore.get()[0]!);
    healthStore.degrade({ key: 'session-projection', domain: 'session-projection', cause: new Error('new failure'), scope: scopeA });
    pending.resolve(); await retrying;
    expect(healthStore.get()).toMatchObject([{ state: 'degraded', error: { message: 'new failure' } }]);
  });

  it('task cancellation returns an explicit refusal as well as reporting the failure', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('cancel failed'));
    expect(await agentActions.cancelIrisAgentTask('session', 'task')).toBe(false);
    expect(getNotifications()).toMatchObject([{ title: '后台任务取消失败', message: 'cancel failed' }]);
  });
});
