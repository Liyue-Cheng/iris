import { useSyncExternalStore } from 'react';
import { CHANNELS, EVENTS } from '@shared/protocol';
import type {
  GitChangedEvent,
  GitResource,
  GitResourceGroup,
  GitSnapshot,
  ProjectScope,
} from '@shared/types';
import { pipeline } from '@renderer/cpu';
import { alertDialog } from '@renderer/components/ui/confirm-dialog';
import { projectScopeState, sameProjectScope } from './project-scope-state';
import { editorStore } from './editor-store';
import { translate } from '@renderer/i18n';
import { healthStore } from './health-store';

interface State {
  loading: boolean;
  snapshot: GitSnapshot | null;
  error: string | null;
  pending: string | null;
  draft: string;
}

let state: State = { loading: false, snapshot: null, error: null, pending: null, draft: '' };
let nextRequest = 0;
let appliedRequest = 0;
let refreshQueued = false;
const drafts = new Map<string, string>();
const subscribers = new Set<() => void>();
const emit = (): void => subscribers.forEach((callback) => callback());
function set(patch: Partial<State>): void { state = { ...state, ...patch }; emit(); }

function scopeKey(scope: ProjectScope | null): string | null {
  return scope?.root ?? null;
}

function currentDraft(scope = projectScopeState.get()): string {
  const key = scopeKey(scope);
  return key ? drafts.get(key) ?? '' : '';
}

function isProjectionFailure(snapshot: GitSnapshot): boolean {
  return snapshot.error !== null && snapshot.error.code !== 'NotRepository';
}

function runQueuedRefresh(): void {
  const shouldRefresh = refreshQueued;
  refreshQueued = false;
  if (shouldRefresh) void gitStore.refresh();
}

function acceptSnapshot(
  request: number,
  scope: ProjectScope,
  snapshot: GitSnapshot,
): boolean {
  if (!sameProjectScope(scope, projectScopeState.get()) || request < appliedRequest) return false;
  if (
    state.snapshot?.repositoryId &&
    state.snapshot.repositoryId === snapshot.repositoryId &&
    snapshot.revision < state.snapshot.revision
  ) return false;
  appliedRequest = request;
  set({
    snapshot,
    loading: false,
    error: snapshot.error?.message ?? null,
    draft: currentDraft(scope),
  });
  return true;
}

async function readSnapshot(scope: ProjectScope): Promise<GitSnapshot> {
  return window.api.invoke<
    { expectedScope: ProjectScope },
    GitSnapshot
  >(CHANNELS.GIT_STATUS, { expectedScope: scope });
}

export const gitStore = {
  get: (): State => state,

  setDraft(message: string): void {
    const key = scopeKey(projectScopeState.get());
    if (!key) return;
    if (message) drafts.set(key, message);
    else drafts.delete(key);
    set({ draft: message });
  },

  async refresh(): Promise<void> {
    const scope = projectScopeState.get();
    if (!scope) return;
    if (state.pending) {
      refreshQueued = true;
      return;
    }
    const request = ++nextRequest;
    set({ loading: true, error: null, draft: currentDraft(scope) });
    try {
      const snapshot = await readSnapshot(scope);
      if (!acceptSnapshot(request, scope, snapshot)) return;
      if (isProjectionFailure(snapshot)) {
        healthStore.degrade({
          key: 'git-projection',
          domain: 'git-projection',
          cause: snapshot.error,
          scope,
          retry: async () => { await gitStore.refresh(); },
        });
      } else {
        healthStore.resolve('git-projection', scope);
      }
    } catch (cause) {
      if (!sameProjectScope(scope, projectScopeState.get()) || request < appliedRequest) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      set({ loading: false, error: message, draft: currentDraft(scope) });
      healthStore.degrade({
        key: 'git-projection',
        domain: 'git-projection',
        cause,
        scope,
        retry: async () => { await gitStore.refresh(); },
      });
    }
  },

  reset(): void {
    nextRequest += 1;
    appliedRequest = nextRequest;
    refreshQueued = false;
    set({ snapshot: null, loading: false, error: null, pending: null, draft: '' });
  },

  async stage(paths: string[]): Promise<boolean> {
    return this.mutate('stage', 'git.stage', { paths });
  },
  async unstage(paths: string[]): Promise<boolean> {
    return this.mutate('unstage', 'git.unstage', { paths });
  },
  async commit(message: string): Promise<boolean> {
    const scope = projectScopeState.get();
    const succeeded = await this.mutate('commit', 'git.commit', { message });
    if (succeeded && sameProjectScope(scope, projectScopeState.get())) this.setDraft('');
    return succeeded;
  },
  async switchBranch(branch: string): Promise<boolean> {
    return this.mutate('switch-branch', 'git.switch-branch', { branch });
  },

  async mutate(kind: string, instruction: string, payload: unknown): Promise<boolean> {
    if (state.pending || state.snapshot?.stale) return false;
    const scope = projectScopeState.get();
    if (!scope) return false;
    set({ pending: kind, error: null, draft: currentDraft(scope) });
    if (!(await editorStore.flushBeforeSwitch('before-external-action'))) {
      if (sameProjectScope(scope, projectScopeState.get())) set({ pending: null });
      runQueuedRefresh();
      return false;
    }
    if (!sameProjectScope(scope, projectScopeState.get())) return false;
    const request = ++nextRequest;
    try {
      const snapshot = await pipeline.dispatch(instruction, payload) as GitSnapshot;
      if (!sameProjectScope(scope, projectScopeState.get())) return false;
      if (!acceptSnapshot(request, scope, snapshot)) return false;
      set({ pending: null });
      if (isProjectionFailure(snapshot)) {
        healthStore.degrade({
          key: 'git-projection',
          domain: 'git-projection',
          cause: snapshot.error,
          scope,
          retry: async () => { await gitStore.refresh(); },
        });
      } else {
        healthStore.resolve('git-projection', scope);
      }
      runQueuedRefresh();
      return true;
    } catch (cause) {
      if (!sameProjectScope(scope, projectScopeState.get()) || request < appliedRequest) return false;
      appliedRequest = request;
      const message = cause instanceof Error ? cause.message : String(cause);
      set({ pending: null, error: message, draft: currentDraft(scope) });
      void alertDialog({ title: translate('git.operationFailed'), message });
      runQueuedRefresh();
      return false;
    }
  },

  /** Test-only reset for module-persistent drafts and request counters. */
  resetForTests(): void {
    drafts.clear();
    nextRequest = 0;
    appliedRequest = 0;
    refreshQueued = false;
    state = { loading: false, snapshot: null, error: null, pending: null, draft: '' };
    emit();
  },
};

window.api.on<GitChangedEvent>(EVENTS.GIT_CHANGED, (event) => {
  if (sameProjectScope(event.projectScope, projectScopeState.get())) void gitStore.refresh();
});
window.addEventListener('focus', () => { if (state.snapshot) void gitStore.refresh(); });

export function useGit(): State {
  return useSyncExternalStore(
    (callback) => { subscribers.add(callback); return () => subscribers.delete(callback); },
    () => state,
  );
}
export type { GitResource, GitResourceGroup };
