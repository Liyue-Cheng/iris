/** UI action boundaries for terminal session lifecycle. */
import { pipeline } from '@renderer/cpu';
import {
  getLastTerminalDims,
  sessionStore,
  type TerminalLayoutScope,
} from '@renderer/stores/session-store';
import type { TerminalSessionInfo } from '@shared/types';
import { editorStore } from '@renderer/stores/editor-store';
import { projectStore } from '@renderer/stores/project-store';
import { runProjectAction } from './action-runtime';
import { translate } from '@renderer/i18n';
import { sessionCloseOutcome, type SessionCloseOutcome } from './session-close-outcome';

function initialTerminalDims(scope: TerminalLayoutScope): { cols: number; rows: number } {
  return getLastTerminalDims(projectStore.get().scan?.projectRoot, scope);
}

async function performOpenSession(
  docPath: string | null,
  agentId: string,
  workspacePath?: string | null,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  // Flush first so the spawned agent reads the current document bytes.
  if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return;
  if (!isCurrent()) return;
  const navigated = docPath === null
    ? await projectStore.selectRoot()
    : await projectStore.selectDoc(docPath);
  if (!navigated || !isCurrent()) return;
  const scope: TerminalLayoutScope =
    docPath === null ? { kind: 'root-hub' } : { kind: 'doc-right-pane' };
  const { cols, rows } = initialTerminalDims(scope);
  const created = await pipeline.dispatch<
    {
      docPath: string | null;
      workspacePath?: string | null;
      agentId: string;
      cols: number;
      rows: number;
    },
    TerminalSessionInfo
  >('session.open', {
    docPath,
    ...(workspacePath === undefined ? {} : { workspacePath }),
    agentId,
    cols,
    rows,
  });
  if (isCurrent()) await projectStore.activateSession(created.id);
}

async function performOpenWorkspaceSession(
  workspacePath: string,
  agentId: string,
  isCurrent: () => boolean,
): Promise<void> {
  if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return;
  if (!isCurrent()) return;
  const navigated = workspacePath === '.iris'
    ? await projectStore.selectRoot()
    : await projectStore.selectWorkspace(workspacePath);
  if (!navigated || !isCurrent()) return;
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
    TerminalSessionInfo
  >('session.open', {
    docPath: null,
    workspacePath,
    agentId,
    cols,
    rows,
  });
  if (isCurrent()) await projectStore.activateSession(created.id);
}

async function runSessionOpen(
  dedupeKey: string,
  operation: (isCurrent: () => boolean) => Promise<void>,
): Promise<void> {
  await runProjectAction(
    { title: translate('errors.sessionOpenFailed'), dedupeKey, concurrency: 'independent' },
    operation,
  );
}

export async function openSession(
  docPath: string | null,
  agentId: string,
  workspacePath?: string | null,
): Promise<void> {
  await runSessionOpen(
    `session:open:${docPath ?? 'root'}:${agentId}`,
    (isCurrent) => performOpenSession(docPath, agentId, workspacePath, isCurrent),
  );
}

export async function openWorkspaceSession(workspacePath: string, agentId: string): Promise<void> {
  await runSessionOpen(
    `session:open:${workspacePath}:${agentId}`,
    (isCurrent) => performOpenWorkspaceSession(workspacePath, agentId, isCurrent),
  );
}

export async function closeSession(sessionId: string): Promise<SessionCloseOutcome> {
  const outcome = await runProjectAction(
    {
      title: translate('errors.sessionCloseFailed'),
      dedupeKey: `session:close:${sessionId}`,
      isRelevant: () => sessionStore.has(sessionId),
    },
    () => pipeline.dispatch('session.close', { sessionId }),
  );
  return sessionCloseOutcome(outcome);
}
