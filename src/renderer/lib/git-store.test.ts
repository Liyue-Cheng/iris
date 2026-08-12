import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitSnapshot, ProjectScope } from '@shared/types';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  addEventListener: vi.fn(),
  flush: vi.fn(),
  alert: vi.fn(),
  degrade: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('@renderer/cpu', () => ({ pipeline: { dispatch: mocks.dispatch } }));
vi.mock('@renderer/components/ui/confirm-dialog', () => ({ alertDialog: mocks.alert }));
vi.mock('@renderer/stores/editor-store', () => ({
  editorStore: { flushBeforeSwitch: mocks.flush },
}));
vi.mock('@renderer/i18n', () => ({ translate: (key: string) => key }));
vi.mock('@renderer/stores/health-store', () => ({
  healthStore: { degrade: mocks.degrade, resolve: mocks.resolve },
}));

let gitStore: typeof import('@renderer/stores/git-store').gitStore;
let projectScopeState: typeof import('@renderer/stores/project-scope-state').projectScopeState;
const scopeA: ProjectScope = { root: 'E:\\a', generation: 1 };
const scopeB: ProjectScope = { root: 'E:\\b', generation: 2 };

function snapshot(revision: number, overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    available: true,
    projectRoot: scopeA.root,
    root: scopeA.root,
    gitDir: `${scopeA.root}\\.git`,
    commonDir: `${scopeA.root}\\.git`,
    repositoryId: `${scopeA.root}\0${scopeA.root}\\.git`,
    revision,
    stale: false,
    branch: 'main',
    head: null,
    detached: false,
    ahead: 0,
    behind: 0,
    branches: [],
    groups: { merge: [], index: [], workingTree: [], untracked: [] },
    error: null,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeAll(async () => {
  vi.stubGlobal('window', {
    api: { invoke: mocks.invoke, on: mocks.on },
    addEventListener: mocks.addEventListener,
  });
  ({ projectScopeState } = await import('@renderer/stores/project-scope-state'));
  ({ gitStore } = await import('@renderer/stores/git-store'));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flush.mockResolvedValue(true);
  projectScopeState.set(scopeA);
  gitStore.resetForTests();
});

describe('gitStore', () => {
  it('does not let an older refresh overwrite a mutation result', async () => {
    const oldRefresh = deferred<GitSnapshot>();
    mocks.invoke.mockReturnValueOnce(oldRefresh.promise);
    mocks.dispatch.mockResolvedValueOnce(snapshot(2, { head: 'new' }));

    const refreshing = gitStore.refresh();
    await gitStore.stage(['file.txt']);
    oldRefresh.resolve(snapshot(1, { head: 'old' }));
    await refreshing;

    expect(gitStore.get().snapshot?.head).toBe('new');
    expect(gitStore.get().loading).toBe(false);
  });

  it('does not let two refresh responses apply out of order', async () => {
    const first = deferred<GitSnapshot>();
    const second = deferred<GitSnapshot>();
    mocks.invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const older = gitStore.refresh();
    const newer = gitStore.refresh();
    second.resolve(snapshot(2, { head: 'newer' }));
    await newer;
    first.resolve(snapshot(1, { head: 'older' }));
    await older;

    expect(gitStore.get().snapshot?.head).toBe('newer');
    expect(gitStore.get().loading).toBe(false);
  });

  it('coalesces refreshes raised while a mutation is pending', async () => {
    const mutation = deferred<GitSnapshot>();
    mocks.dispatch.mockReturnValueOnce(mutation.promise);
    mocks.invoke.mockResolvedValueOnce(snapshot(3, { head: 'reconciled' }));

    const staging = gitStore.stage(['file.txt']);
    await vi.waitFor(() => expect(gitStore.get().pending).toBe('stage'));
    await gitStore.refresh();
    expect(mocks.invoke).not.toHaveBeenCalled();

    mutation.resolve(snapshot(2, { head: 'mutation' }));
    await expect(staging).resolves.toBe(true);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(gitStore.get().snapshot?.head).toBe('reconciled'));
  });

  it('blocks a duplicate gesture while the editor flush is pending', async () => {
    const flush = deferred<boolean>();
    mocks.flush.mockReturnValueOnce(flush.promise);
    mocks.dispatch.mockResolvedValueOnce(snapshot(2));

    const first = gitStore.stage(['file.txt']);
    await vi.waitFor(() => expect(gitStore.get().pending).toBe('stage'));
    await expect(gitStore.stage(['file.txt'])).resolves.toBe(false);
    flush.resolve(true);
    await expect(first).resolves.toBe(true);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });

  it('treats a non-repository snapshot as a normal empty projection', async () => {
    mocks.invoke.mockResolvedValueOnce(snapshot(1, {
      available: false,
      root: null,
      repositoryId: null,
      error: { code: 'NotRepository', message: 'not a repository', retryable: false },
    }));
    await gitStore.refresh();
    expect(mocks.degrade).not.toHaveBeenCalled();
    expect(mocks.resolve).toHaveBeenCalledWith('git-projection', scopeA);
  });

  it('blocks mutations while only a stale snapshot is available', async () => {
    mocks.invoke.mockResolvedValueOnce(snapshot(2, {
      stale: true,
      error: { code: 'Timeout', message: 'status timed out', retryable: true },
    }));
    await gitStore.refresh();
    await expect(gitStore.commit('do not commit stale state')).resolves.toBe(false);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('keeps the last snapshot when an IPC refresh fails', async () => {
    mocks.invoke.mockResolvedValueOnce(snapshot(1)).mockRejectedValueOnce(new Error('offline'));
    await gitStore.refresh();
    await gitStore.refresh();

    expect(gitStore.get().snapshot?.revision).toBe(1);
    expect(gitStore.get()).toMatchObject({ loading: false, error: 'offline' });
  });

  it('keeps a commit draft after failure and clears it only after success', async () => {
    gitStore.setDraft('important message');
    mocks.dispatch.mockRejectedValueOnce(new Error('hook rejected'));
    await expect(gitStore.commit(gitStore.get().draft)).resolves.toBe(false);
    expect(gitStore.get().draft).toBe('important message');

    mocks.dispatch.mockResolvedValueOnce(snapshot(2, { head: 'committed' }));
    await expect(gitStore.commit(gitStore.get().draft)).resolves.toBe(true);
    expect(gitStore.get().draft).toBe('');
  });

  it('isolates drafts between project generations', async () => {
    gitStore.setDraft('draft A');
    gitStore.reset();
    projectScopeState.set(scopeB);
    mocks.invoke.mockResolvedValueOnce(snapshot(1, {
      projectRoot: scopeB.root,
      root: scopeB.root,
      repositoryId: 'repository-b',
    }));
    await gitStore.refresh();
    expect(gitStore.get().draft).toBe('');

    gitStore.setDraft('draft B');
    gitStore.reset();
    projectScopeState.set(scopeA);
    mocks.invoke.mockResolvedValueOnce(snapshot(2));
    await gitStore.refresh();
    expect(gitStore.get().draft).toBe('draft A');
  });

  it('restores a draft when the same project is reopened with a new generation', async () => {
    gitStore.setDraft('persistent draft');
    gitStore.reset();
    const reopened = { ...scopeA, generation: 99 };
    projectScopeState.set(reopened);
    mocks.invoke.mockResolvedValueOnce(snapshot(2));
    await gitStore.refresh();
    expect(gitStore.get().draft).toBe('persistent draft');
  });

  it('ignores a response after the project scope changes', async () => {
    const pending = deferred<GitSnapshot>();
    mocks.invoke.mockReturnValueOnce(pending.promise);
    const refreshing = gitStore.refresh();
    projectScopeState.set(scopeB);
    pending.resolve(snapshot(1));
    await refreshing;
    expect(gitStore.get().snapshot).toBeNull();
  });
});
