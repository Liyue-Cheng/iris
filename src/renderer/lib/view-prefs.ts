/**
 * Per-panel view preferences (group-by / sort / order / collapsed groups).
 * These are display-only, machine-local choices — not project data — so they
 * live in localStorage, never in `.iris/`. A tiny external store keeps every
 * mounted panel in sync without prop-drilling or a main-process round trip.
 */
import { useCallback, useSyncExternalStore } from 'react';

// v2: dropped the `priority` group/sort options — discard any persisted
// `priority` value so stale prefs can't select a now-removed branch.
const KEY = 'iris.view-prefs.v2';

type PrefBag = Record<string, unknown>;
let store: Record<string, PrefBag> = load();
const subscribers = new Set<() => void>();

function load(): Record<string, PrefBag> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, PrefBag>) : {};
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* private mode / quota — prefs just won't persist this session */
  }
}

/**
 * Read+write one panel's prefs, merged over `defaults`. The merge happens
 * after the snapshot read, so the external-store snapshot stays referentially
 * stable (and useSyncExternalStore won't loop).
 */
export function useViewPref<T extends Record<string, unknown>>(
  id: string,
  defaults: T,
): [T, (patch: Partial<T>) => void] {
  const snap = useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => store[id],
  );
  const value = { ...defaults, ...(snap ?? {}) } as T;
  const set = useCallback(
    (patch: Partial<T>) => {
      store = { ...store, [id]: { ...(store[id] ?? {}), ...patch } };
      persist();
      subscribers.forEach((cb) => cb());
    },
    [id],
  );
  return [value, set];
}
