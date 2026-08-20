/** UI action boundaries for terminal session lifecycle. */
import { pipeline } from '@renderer/cpu';
import {
  getLastTerminalDims,
  type TerminalLayoutScope,
} from '@renderer/stores/session-store';
import type { SessionInfo } from '@shared/types';
import { editorStore } from '@renderer/stores/editor-store';
import { projectStore } from '@renderer/stores/project-store';
import { runUserAction } from './action-runtime';
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

async function runSessionOpen(
  dedupeKey: string,
  operation: () => Promise<void>,
): Promise<void> {
  await runUserAction(
    { title: translate('errors.sessionOpenFailed'), dedupeKey },
    operation,
  );
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
