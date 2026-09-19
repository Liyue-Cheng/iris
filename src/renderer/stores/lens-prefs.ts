/**
 * @file stores/lens-prefs.ts
 * @purpose Left-pane view preferences (round-4 F1/F2): how docs are sorted
 *   inside each type section, and a free-text filter over file name + title.
 *   Pure UI state — never touches the world, never enters the pipeline.
 */
import { useSyncExternalStore } from 'react';

export type LensSort = 'mtime' | 'alpha';

export interface LensRevealIntent {
  workspacePath: string;
  section: 'external';
  nonce: number;
}

export interface LensPrefs {
  /** 'mtime' = newest first; 'alpha' = display-title A→Z. */
  sort: LensSort;
  /** Lowercased substring; '' = no filter. */
  filter: string;
  /** Whether the filter input row is shown. */
  filterOpen: boolean;
  revealIntent: LensRevealIntent | null;
}

let state: LensPrefs = { sort: 'mtime', filter: '', filterOpen: false, revealIntent: null };
const subscribers = new Set<() => void>();

function setState(patch: Partial<LensPrefs>): void {
  state = { ...state, ...patch };
  subscribers.forEach((cb) => cb());
}

export const lensPrefs = {
  get(): LensPrefs {
    return state;
  },
  toggleSort(): void {
    setState({ sort: state.sort === 'mtime' ? 'alpha' : 'mtime' });
  },
  setFilter(filter: string): void {
    setState({ filter });
  },
  toggleFilter(): void {
    // Closing also clears the query so a hidden filter never silently hides docs.
    setState({ filterOpen: !state.filterOpen, filter: state.filterOpen ? '' : state.filter });
  },
  revealExternal(workspacePath: string): void {
    setState({ revealIntent: { workspacePath, section: 'external', nonce: Date.now() } });
  },
  clearReveal(nonce: number): void {
    if (state.revealIntent?.nonce === nonce) setState({ revealIntent: null });
  },
};

export function useLensPrefs(): LensPrefs {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    () => state,
  );
}
