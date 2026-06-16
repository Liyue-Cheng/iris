/**
 * UI actions for sessions. The verb is the session.open / session.close
 * instruction; initial cols/rows come from the last fit() measurement so
 * ConPTY spawns at (or near) the real size — spawn-then-resize makes
 * PowerShell repaint its banner and shreds early progress-bar lines.
 */
import { pipeline } from '@renderer/cpu';
import { getLastTerminalDims } from '@renderer/stores/session-store';
import { editorStore } from '@renderer/stores/editor-store';
import { projectStore } from '@renderer/stores/project-store';

export async function openSession(docPath: string | null, agentId: string): Promise<void> {
  // Round-4 A1/A2: the core gesture injects FOCUS_DOC and the agent `cat`s
  // the doc on spawn — flush pending editor edits FIRST so it reads the
  // current bytes, not the last-saved ones.
  await editorStore.flushBeforeSwitch();
  // The right pane is anchor-driven: it shows only the sessions whose docPath
  // matches the middle pane's view anchor. A spawn sets activeSessionId but
  // NOT the view, so opening under an anchor other than the current view
  // stages the new session invisibly — e.g. the root-node + while a doc is
  // selected spawns a root session the doc-anchored pane filters out. Bring
  // the view to the session's anchor so the new terminal actually surfaces.
  // See issue 2026-06-16-项目根开终端右栏不切换.
  if (docPath === null) await projectStore.selectRoot();
  else await projectStore.selectDoc(docPath);
  const { cols, rows } = getLastTerminalDims();
  await pipeline.dispatch('session.open', { docPath, agentId, cols, rows });
}

export async function closeSession(sessionId: string): Promise<void> {
  await pipeline.dispatch('session.close', { sessionId });
}
