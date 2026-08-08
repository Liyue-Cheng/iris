import type { ProjectScope } from '@shared/types';

let activeScope: ProjectScope | null = null;
let switching = false;

export function sameProjectScope(
  a: ProjectScope | null | undefined,
  b: ProjectScope | null | undefined,
): boolean {
  return a?.root === b?.root && a?.generation === b?.generation;
}

/** Lightweight, non-reactive authority shared by the CPU transport and stores. */
export const projectScopeState = {
  get(): ProjectScope | null {
    return activeScope;
  },

  set(scope: ProjectScope | null): void {
    activeScope = scope;
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
