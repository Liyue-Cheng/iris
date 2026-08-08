/**
 * UI actions for sessions. The verb is the session.open / session.close
 * instruction; initial cols/rows come from the last fit() measurement for
 * the same project and layout region so ConPTY spawns at (or near) the real
 * size — spawn-then-resize makes PowerShell repaint its banner and shreds
 * early progress-bar lines.
 */
import { pipeline } from '@renderer/cpu';
import {
  getLastTerminalDims,
  type TerminalLayoutScope,
} from '@renderer/stores/session-store';
import { editorStore } from '@renderer/stores/editor-store';
import { projectStore } from '@renderer/stores/project-store';

function initialTerminalDims(scope: TerminalLayoutScope): { cols: number; rows: number } {
  return getLastTerminalDims(projectStore.get().scan?.projectRoot, scope);
}

export async function openSession(docPath: string | null, agentId: string): Promise<void> {
  // Round-4 A1/A2: the core gesture injects FOCUS_DOC and the agent `cat`s
  // the doc on spawn — flush pending editor edits FIRST so it reads the
  // current bytes, not the last-saved ones.
  if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return;
  // The right pane is anchor-driven: it shows only the sessions whose docPath
  // matches the middle pane's view anchor. A spawn sets activeSessionId but
  // NOT the view, so opening under an anchor other than the current view
  // stages the new session invisibly — e.g. the root-node + while a doc is
  // selected spawns a root session the doc-anchored pane filters out. Bring
  // the view to the session's anchor so the new terminal actually surfaces.
  // See issue 2026-06-16-项目根开终端右栏不切换.
  if (docPath === null) await projectStore.selectRoot();
  else await projectStore.selectDoc(docPath);
  const scope: TerminalLayoutScope =
    docPath === null ? { kind: 'root-hub' } : { kind: 'doc-right-pane' };
  const { cols, rows } = initialTerminalDims(scope);
  await pipeline.dispatch('session.open', {
    docPath,
    agentId,
    cols,
    rows,
  });
}

/**
 * Spawn a workspace-hub session (terminal parity for sub-workspaces): no
 * FOCUS_DOC, cwd = project root, with IRIS_WORKSPACE_PATH carrying the given
 * workspace (`.iris` = project root). Stage the matching hub view so the new
 * terminal surfaces in the right pane.
 */
export async function openWorkspaceSession(workspacePath: string, agentId: string): Promise<void> {
  if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return;
  if (workspacePath === '.iris') await projectStore.selectRoot();
  else await projectStore.selectWorkspace(workspacePath);
  const scope: TerminalLayoutScope =
    workspacePath === '.iris'
      ? { kind: 'root-hub' }
      : { kind: 'workspace-hub', workspacePath };
  const { cols, rows } = initialTerminalDims(scope);
  await pipeline.dispatch('session.open', {
    docPath: null,
    workspacePath,
    agentId,
    cols,
    rows,
  });
}

export async function closeSession(sessionId: string): Promise<void> {
  await pipeline.dispatch('session.close', { sessionId });
}
