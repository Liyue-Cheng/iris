import { normalize, resolve } from 'node:path';
import type {
  ProjectOpenResult,
  ProjectScope,
  ProjectSettingsSnapshot,
  SessionInfo,
} from '@shared/types';
import type { WindowContext } from './window-context';
import { logger } from './logger';

export interface ProjectSwitchRequest {
  root: string;
  expectedScope: ProjectScope | null;
}

function sameScope(a: ProjectScope | null, b: ProjectScope | null): boolean {
  return a?.root === b?.root && a?.generation === b?.generation;
}

function sessionsForScope(ctx: WindowContext, scope: ProjectScope): SessionInfo[] {
  return ctx.sessionManager
    .list()
    .filter(
      (session) =>
        session.projectRoot === scope.root &&
        session.projectGeneration === scope.generation,
    );
}

/**
 * Serialize and execute one same-window project open/switch. CPU establishes
 * renderer ordering; this queue remains authoritative across IPC timeout,
 * retries, direct invokes, and renderer crashes.
 */
export function enqueueProjectSwitch(
  ctx: WindowContext,
  request: ProjectSwitchRequest,
  onCommitted: (scope: ProjectScope) => void,
  readProjectSettings: (scope: ProjectScope) => Promise<ProjectSettingsSnapshot>,
): Promise<ProjectOpenResult> {
  const run = ctx.projectSwitchTail.catch(() => undefined).then(async () => {
    if (!sameScope(request.expectedScope, ctx.projectScope)) {
      throw new Error('[project:open] stale project scope');
    }

    const targetRoot = normalize(resolve(request.root));
    const current = ctx.projectScope;
    if (current?.root === targetRoot && ctx.projectManager.getRoot() === targetRoot) {
      const [scan, projectSettings] = await Promise.all([
        ctx.projectManager.scan(),
        readProjectSettings(current),
      ]);
      return {
        scope: current,
        scan,
        sessions: sessionsForScope(ctx, current),
        projectSettings,
      };
    }

    ctx.projectSwitching = true;
    try {
      const prepared = await ctx.projectManager.prepareOpen(targetRoot);
      // realpath preflight collapses Windows casing, junction and symlink
      // aliases. Re-check identity before crossing the destructive boundary.
      if (current?.root === prepared.root && ctx.projectManager.getRoot() === prepared.root) {
        const projectSettings = await readProjectSettings(current);
        return {
          scope: current,
          scan: prepared.scan,
          sessions: sessionsForScope(ctx, current),
          projectSettings,
        };
      }

      // Point of no return. A killed process cannot be rolled back; after the
      // complete preflight above, finish forward under the main-side gate.
      if (current) {
        await Promise.all([
          ctx.sessionManager.closeProject(current),
          ctx.agentSessionManager.closeProject(current),
        ]);
      }
      const scan = await ctx.projectManager.activatePrepared(prepared);
      try {
        await ctx.gitManager.open(prepared.root);
      } catch (err) {
        logger.warn('project', `git watcher setup failed for ${prepared.root}`, err);
      }

      const scope: ProjectScope = {
        root: prepared.root,
        generation: (current?.generation ?? 0) + 1,
      };
      ctx.projectScope = scope;
      ctx.projectRoot = scope.root;
      try {
        onCommitted(scope);
      } catch (err) {
        logger.warn('project', `post-commit persistence failed for ${scope.root}`, err);
      }
      const projectSettings = await readProjectSettings(scope);
      return { scope, scan, sessions: [], projectSettings };
    } finally {
      ctx.projectSwitching = false;
    }
  });
  ctx.projectSwitchTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
