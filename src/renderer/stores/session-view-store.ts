import { useSyncExternalStore } from 'react';
import type { ProjectScope } from '@shared/types';
import type { SessionKey } from '@renderer/lib/session-projection';

let selectedByAnchor: Readonly<Record<string, SessionKey>> = {};
const subscribers = new Set<() => void>();

function key(scope: ProjectScope, anchorKey: string): string {
  return `${scope.root}\u0000${scope.generation}\u0000${anchorKey}`;
}

export const sessionViewStore = {
  select(scope: ProjectScope, anchorKey: string, sessionKey: SessionKey): void {
    selectedByAnchor = { ...selectedByAnchor, [key(scope, anchorKey)]: sessionKey };
    subscribers.forEach((subscriber) => subscriber());
  },

  selected(scope: ProjectScope | null, anchorKey: string | null): SessionKey | null {
    if (!scope || !anchorKey) return null;
    return selectedByAnchor[key(scope, anchorKey)] ?? null;
  },

  /** Project generations are isolated; discard stale selections on a switch. */
  clear(): void {
    if (Object.keys(selectedByAnchor).length === 0) return;
    selectedByAnchor = {};
    subscribers.forEach((subscriber) => subscriber());
  },
};

export function useSelectedSessionView(
  scope: ProjectScope | null,
  anchorKey: string | null,
): string | null {
  return useSyncExternalStore(
    (subscriber) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    () => sessionViewStore.selected(scope, anchorKey),
  );
}
