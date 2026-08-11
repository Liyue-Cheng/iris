/** UI action boundaries for terminal session lifecycle. */
import { pipeline } from '@renderer/cpu';
import {
  getLastTerminalDims,
  type TerminalLayoutScope,
} from '@renderer/stores/session-store';
import type { SessionInfo } from '@shared/types';
import type { PromptNotReadyDetails } from '@shared/app-error';
import { editorStore } from '@renderer/stores/editor-store';
import { projectStore } from '@renderer/stores/project-store';
import { attemptAction, runUserAction, type UiAppError } from './action-runtime';
import { notify } from '@renderer/stores/notification-store';
import { actionDialog } from '@renderer/components/ui/confirm-dialog';
import { openSettingsView } from '@renderer/components/settings/SettingsView';
import { translate } from '@renderer/i18n';

function initialTerminalDims(scope: TerminalLayoutScope): { cols: number; rows: number } {
  return getLastTerminalDims(projectStore.get().scan?.projectRoot, scope);
}

async function performOpenSession(docPath: string | null, agentId: string): Promise<void> {
  // Flush first so the spawned agent reads the current document bytes.
  if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return;
  const navigated = docPath === null
    ? await projectStore.selectRoot()
    : await projectStore.selectDoc(docPath);
  if (!navigated) return;
  const scope: TerminalLayoutScope =
    docPath === null ? { kind: 'root-hub' } : { kind: 'doc-right-pane' };
  const { cols, rows } = initialTerminalDims(scope);
  const created = await pipeline.dispatch<
    { docPath: string | null; agentId: string; cols: number; rows: number },
    SessionInfo
  >('session.open', { docPath, agentId, cols, rows });
  await projectStore.activateSession(created.id);
}

async function performOpenWorkspaceSession(
  workspacePath: string,
  agentId: string,
): Promise<void> {
  if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return;
  const navigated = workspacePath === '.iris'
    ? await projectStore.selectRoot()
    : await projectStore.selectWorkspace(workspacePath);
  if (!navigated) return;
  const scope: TerminalLayoutScope = workspacePath === '.iris'
    ? { kind: 'root-hub' }
    : { kind: 'workspace-hub', workspacePath };
  const { cols, rows } = initialTerminalDims(scope);
  const created = await pipeline.dispatch<
    {
      docPath: null;
      workspacePath: string;
      agentId: string;
      cols: number;
      rows: number;
    },
    SessionInfo
  >('session.open', {
    docPath: null,
    workspacePath,
    agentId,
    cols,
    rows,
  });
  await projectStore.activateSession(created.id);
}

function promptDetails(error: UiAppError): PromptNotReadyDetails | null {
  if (error.domain !== 'prompt' || error.code !== 'PromptNotReady') return null;
  const details = error.details as Partial<PromptNotReadyDetails> | undefined;
  if (!details || typeof details.repairable !== 'boolean' || !Array.isArray(details.issues)) {
    return null;
  }
  return details as PromptNotReadyDetails;
}

function reportSessionFailure(title: string, dedupeKey: string, error: UiAppError): void {
  notify({
    dedupeKey,
    title,
    message: error.message,
    domain: error.domain,
    ...(error.incidentId !== undefined ? { incidentId: error.incidentId } : {}),
  });
}

async function runSessionOpen(
  dedupeKey: string,
  operation: () => Promise<void>,
): Promise<void> {
  const initial = await attemptAction(operation);
  if (initial.status !== 'failed') return;
  const details = promptDetails(initial.error);
  if (!details) {
    reportSessionFailure(translate('errors.sessionOpenFailed'), dedupeKey, initial.error);
    return;
  }

  const issueLines = details.issues.map((issue) => {
    const target = issue.path ?? '.iris/settings.json';
    return `${target} · ${issue.layer}: ${issue.state}${issue.message ? `\n  ${issue.message}` : ''}`;
  });
  const result = await actionDialog({
    title: translate('errors.promptNotReadyTitle'),
    message: translate('errors.promptNotReadyMessage', { issues: issueLines.join('\n') }),
    primaryText: details.repairable
      ? translate('errors.syncAndStart')
      : translate('errors.openPromptSettings'),
    ...(details.repairable
      ? { secondaryText: translate('errors.openPromptSettings') }
      : {}),
  });
  if (result === 'secondary' || (result === 'primary' && !details.repairable)) {
    openSettingsView('prompts');
    return;
  }
  if (result !== 'primary') return;

  // The repair and the single retry are one user action; never recurse.
  const repaired = await attemptAction(async () => {
    await pipeline.dispatch('prompt.sync-all', {});
    await operation();
  });
  if (repaired.status === 'failed') {
    reportSessionFailure(translate('errors.sessionOpenFailed'), dedupeKey, repaired.error);
  }
}

export async function openSession(docPath: string | null, agentId: string): Promise<void> {
  await runSessionOpen(
    `session:open:${docPath ?? 'root'}:${agentId}`,
    () => performOpenSession(docPath, agentId),
  );
}

export async function openWorkspaceSession(workspacePath: string, agentId: string): Promise<void> {
  await runSessionOpen(
    `session:open:${workspacePath}:${agentId}`,
    () => performOpenWorkspaceSession(workspacePath, agentId),
  );
}

export async function closeSession(sessionId: string): Promise<void> {
  await runUserAction(
    {
      title: translate('errors.sessionCloseFailed'),
      dedupeKey: `session:close:${sessionId}`,
    },
    () => pipeline.dispatch('session.close', { sessionId }),
  );
}
