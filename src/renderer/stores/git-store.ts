import { useSyncExternalStore } from 'react';
import { CHANNELS, EVENTS } from '@shared/protocol';
import type { GitChangedEvent, GitResource, GitResourceGroup, GitSnapshot } from '@shared/types';
import { pipeline } from '@renderer/cpu';
import { alertDialog } from '@renderer/components/ui/confirm-dialog';
import { projectScopeState, sameProjectScope } from './project-scope-state';
import { editorStore } from './editor-store';
import { translate } from '@renderer/i18n';

type State = { loading: boolean; snapshot: GitSnapshot | null; error: string | null; pending: string | null };
let state: State = { loading: false, snapshot: null, error: null, pending: null };
const subscribers = new Set<() => void>();
const emit = (): void => subscribers.forEach((cb) => cb());
function set(patch: Partial<State>): void { state = { ...state, ...patch }; emit(); }

export const gitStore = {
  get: (): State => state,
  async refresh(): Promise<void> {
    const scope = projectScopeState.get();
    if (!scope) return;
    set({ loading: true, error: null });
    try {
      const snapshot = await window.api.invoke<
        { expectedScope: typeof scope },
        GitSnapshot
      >(CHANNELS.GIT_STATUS, { expectedScope: scope });
      if (!sameProjectScope(scope, projectScopeState.get())) return;
      set({ snapshot, loading: false });
    }
    catch (err) { set({ loading: false, error: err instanceof Error ? err.message : String(err) }); }
  },
  reset(): void { set({ snapshot: null, loading: false, error: null, pending: null }); },
  async stage(paths: string[]): Promise<void> { await this.mutate('stage', 'git.stage', { paths }); },
  async unstage(paths: string[]): Promise<void> { await this.mutate('unstage', 'git.unstage', { paths }); },
  async commit(message: string): Promise<void> { await this.mutate('commit', 'git.commit', { message }); },
  async switchBranch(branch: string): Promise<void> { await this.mutate('switch-branch', 'git.switch-branch', { branch }); },
  async mutate(kind: string, instruction: string, payload: unknown): Promise<void> {
    if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return;
    set({ pending: kind, error: null });
    try {
      const snapshot = await pipeline.dispatch(instruction, payload) as GitSnapshot;
      set({ snapshot, pending: null });
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ pending: null, error: msg });
      void alertDialog({ title: translate('git.operationFailed'), message: msg });
    }
  },
};

window.api.on<GitChangedEvent>(EVENTS.GIT_CHANGED, (event) => {
  if (sameProjectScope(event.projectScope, projectScopeState.get())) void gitStore.refresh();
});
window.addEventListener('focus', () => { if (state.snapshot) void gitStore.refresh(); });

export function useGit(): State { return useSyncExternalStore((cb) => { subscribers.add(cb); return () => subscribers.delete(cb); }, () => state); }
export type { GitResource, GitResourceGroup };
