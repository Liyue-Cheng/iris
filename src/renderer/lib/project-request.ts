import type { ProjectScope } from '@shared/types';
import { projectScopeState, sameProjectScope } from '@renderer/stores/project-scope-state';

/** One tracker per projection; both successful and failed reads share its order. */
export function createProjectRequestTracker(): {
  begin: (scope: ProjectScope) => () => boolean;
} {
  let latest = 0;
  return {
    begin(scope) {
      const request = ++latest;
      return () => request === latest && sameProjectScope(scope, projectScopeState.get());
    },
  };
}
