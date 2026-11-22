import type { ProjectScope } from '@shared/types';

let activeScope: ProjectScope | null = null;
let switching = false;
const subscribers = new Set<() => void>();

export function sameProjectScope(
  a: ProjectScope | null | undefined,
  b: ProjectScope | null | undefined,
): boolean {
  return a?.root === b?.root && a?.generation === b?.generation;
}

/** Project identity shared by transport, stores and owners of pending UI work. */
export const projectScopeState = {
  subscribe(listener: () => void): () => void {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },

  get(): ProjectScope | null {
    return activeScope;
  },

  set(scope: ProjectScope | null): void {
    if (sameProjectScope(activeScope, scope)) return;
    activeScope = scope;
    subscribers.forEach((listener) => listener());
  },

  isSwitching(): boolean {
    return switching;
  },

  setSwitching(value: boolean): void {
    switching = value;
  },

  payload<T extends Record<string, unknown>>(payload: T): T & {
    expectedScope: ProjectScope | null;
  } {
    return { ...payload, expectedScope: activeScope };
  },
};
