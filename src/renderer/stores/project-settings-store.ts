import { useSyncExternalStore } from 'react';
import { CHANNELS } from '@shared/protocol';
import type { ProjectScope, ProjectSettingsSnapshot } from '@shared/types';
import { projectScopeState, sameProjectScope } from './project-scope-state';

export interface ProjectSettingsState {
  scope: ProjectScope | null;
  snapshot: ProjectSettingsSnapshot | null;
  loading: boolean;
  error: string | null;
}

let state: ProjectSettingsState = {
  scope: null,
  snapshot: null,
  loading: false,
  error: null,
};
const subscribers = new Set<() => void>();

function setState(patch: Partial<ProjectSettingsState>): void {
  state = { ...state, ...patch };
  subscribers.forEach((callback) => callback());
}

export const projectSettingsStore = {
  get(): ProjectSettingsState {
    return state;
  },

  reset(scope: ProjectScope | null = null): void {
    setState({ scope, snapshot: null, loading: false, error: null });
  },

  /** Install the settings bundled with a successful project-open transaction. */
  install(snapshot: ProjectSettingsSnapshot, scope: ProjectScope): void {
    setState({ scope, snapshot, loading: false, error: snapshot.error });
  },

  handleSnapshot(snapshot: ProjectSettingsSnapshot, scope = projectScopeState.get()): void {
    if (!scope || !sameProjectScope(scope, projectScopeState.get())) return;
    setState({ scope, snapshot, loading: false, error: snapshot.error });
  },

  markTrusted(): void {
    if (!state.snapshot) return;
    setState({ snapshot: { ...state.snapshot, trusted: true } });
  },

  async refresh(scope = projectScopeState.get()): Promise<void> {
    if (!scope) {
      this.reset(null);
      return;
    }
    setState({ scope, loading: true, error: null });
    try {
      const snapshot = await window.api.invoke<
        { expectedScope: ProjectScope },
        ProjectSettingsSnapshot
      >(CHANNELS.PROJECT_SETTINGS_GET, { expectedScope: scope });
      if (!sameProjectScope(scope, projectScopeState.get())) return;
      this.handleSnapshot(snapshot, scope);
    } catch (err) {
      if (!sameProjectScope(scope, projectScopeState.get())) return;
      setState({
        scope,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

export function useProjectSettings(): ProjectSettingsState {
  return useSyncExternalStore(
    (onStoreChange) => {
      subscribers.add(onStoreChange);
      return () => subscribers.delete(onStoreChange);
    },
    () => state,
  );
}

export async function hydrateProjectSettings(): Promise<void> {
  await projectSettingsStore.refresh();
}
