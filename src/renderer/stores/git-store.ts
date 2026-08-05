import { useSyncExternalStore } from 'react';
import { CHANNELS, EVENTS } from '@shared/protocol';
import type { GitResource, GitResourceGroup, GitSnapshot } from '@shared/types';
import { pipeline } from '@renderer/cpu';

type State = { loading: boolean; snapshot: GitSnapshot | null; error: string | null; pending: string | null };
let state: State = { loading: false, snapshot: null, error: null, pending: null };
const subscribers = new Set<() => void>();
const emit = (): void => subscribers.forEach((cb) => cb());
function set(patch: Partial<State>): void { state = { ...state, ...patch }; emit(); }

export const gitStore = {
  get: (): State => state,
  async refresh(): Promise<void> {
    set({ loading: true, error: null });
    try { set({ snapshot: await window.api.invoke<undefined, GitSnapshot>(CHANNELS.GIT_STATUS), loading: false }); }
    catch (err) { set({ loading: false, error: err instanceof Error ? err.message : String(err) }); }
  },
  async stage(paths: string[]): Promise<void> { await this.mutate('stage', 'git.stage', { paths }); },
  async unstage(paths: string[]): Promise<void> { await this.mutate('unstage', 'git.unstage', { paths }); },
  async commit(message: string): Promise<void> { await this.mutate('commit', 'git.commit', { message }); },
  async switchBranch(branch: string): Promise<void> { await this.mutate('switch-branch', 'git.switch-branch', { branch }); },
  async mutate(kind: string, instruction: string, payload: unknown): Promise<void> {
    set({ pending: kind, error: null });
    try {
      const snapshot = await pipeline.dispatch(instruction, payload) as GitSnapshot;
      set({ snapshot, pending: null });
    }
    catch (err) { set({ pending: null, error: err instanceof Error ? err.message : String(err) }); }
  },
};

window.api.on(EVENTS.GIT_CHANGED, () => { void gitStore.refresh(); });
window.addEventListener('focus', () => { if (state.snapshot) void gitStore.refresh(); });

export function useGit(): State { return useSyncExternalStore((cb) => { subscribers.add(cb); return () => subscribers.delete(cb); }, () => state); }
export type { GitResource, GitResourceGroup };
