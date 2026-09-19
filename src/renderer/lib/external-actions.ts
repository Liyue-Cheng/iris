import type {
  ExternalPathEntry,
  ExternalPathIdentity,
  WorkspaceExternalPaths,
} from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { pipeline } from '@renderer/cpu';
import { projectScopeState, sameProjectScope } from '@renderer/stores/project-scope-state';
import { runUserAction } from './action-runtime';
import { translate } from '@renderer/i18n';

export function externalIdentity(
  workspacePath: string,
  entry: Pick<ExternalPathEntry, 'storedPath' | 'line'>,
): ExternalPathIdentity {
  return { workspacePath, storedPath: entry.storedPath, line: entry.line };
}

export async function listExternalPaths(workspacePath: string): Promise<WorkspaceExternalPaths> {
  const scope = projectScopeState.get();
  if (!scope) throw new Error('[external:list] no active project scope');
  const result = await window.api.invoke<
    { workspacePath: string; expectedScope: typeof scope },
    WorkspaceExternalPaths
  >(CHANNELS.EXTERNAL_LIST, { workspacePath, expectedScope: scope });
  if (!sameProjectScope(scope, projectScopeState.get())) {
    throw new Error('[external:list] stale project response');
  }
  return result;
}

export async function addExternalPath(
  workspacePath: string,
  targetPath: string,
): Promise<ExternalPathEntry> {
  return pipeline.dispatch('external.add', { workspacePath, targetPath }) as Promise<ExternalPathEntry>;
}

export async function removeExternalPath(identity: ExternalPathIdentity): Promise<void> {
  await pipeline.dispatch('external.remove', identity);
}

export async function openExternalPath(identity: ExternalPathIdentity): Promise<void> {
  await runUserAction(
    { title: translate('errors.shellOpenFailed'), dedupeKey: `external:open:${identity.workspacePath}:${identity.line}` },
    () => pipeline.dispatch('shell.open-workspace-external', identity),
  );
}

export async function revealExternalPath(identity: ExternalPathIdentity): Promise<void> {
  await runUserAction(
    { title: translate('errors.shellRevealFailed'), dedupeKey: `external:reveal:${identity.workspacePath}:${identity.line}` },
    () => pipeline.dispatch('shell.reveal-workspace-external', identity),
  );
}

export async function pickExternalPath(kind: 'file' | 'directory'): Promise<string | null> {
  return window.api.invoke<{ kind: typeof kind }, string | null>(
    CHANNELS.DIALOG_PICK_EXTERNAL_PATH,
    { kind },
  );
}
