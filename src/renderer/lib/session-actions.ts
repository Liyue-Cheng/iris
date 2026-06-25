/**
 * UI actions for sessions. The verb is the session.open / session.close
 * instruction; initial cols/rows come from the last fit() measurement so
 * ConPTY spawns at (or near) the real size — spawn-then-resize makes
 * PowerShell repaint its banner and shreds early progress-bar lines.
 */
import { pipeline } from '@renderer/cpu';
import type { SessionInfo } from '@shared/types';
import { getLastTerminalDims } from '@renderer/stores/session-store';
import { editorStore } from '@renderer/stores/editor-store';
import { projectStore } from '@renderer/stores/project-store';
import { focusStore } from '@renderer/stores/focus-store';
import { beginTerminalTrace, bindTraceSession, traceMark } from '@renderer/lib/terminal-trace';

export async function openSession(docPath: string | null, agentId: string): Promise<void> {
  const trace = beginTerminalTrace('open', { label: agentId });
  // Round-4 A1/A2: the core gesture injects FOCUS_DOC and the agent `cat`s
  // the doc on spawn — flush pending editor edits FIRST so it reads the
  // current bytes, not the last-saved ones.
  await editorStore.flushBeforeSwitch();
  traceMark(trace, 'flushEditor');
  // The right pane is anchor-driven: it shows only the sessions whose docPath
  // matches the middle pane's view anchor. A spawn sets activeSessionId but
  // NOT the view, so opening under an anchor other than the current view
  // stages the new session invisibly — e.g. the root-node + while a doc is
  // selected spawns a root session the doc-anchored pane filters out. Bring
  // the view to the session's anchor so the new terminal actually surfaces.
  // See issue 2026-06-16-项目根开终端右栏不切换.
  if (docPath === null) await projectStore.selectRoot();
  else await projectStore.selectDoc(docPath);
  traceMark(trace, 'selectView');
  // An explicit spawn always wants the new terminal focused, overriding the
  // doc's focusOnSelectDoc target (P5). The terminal claims once it mounts.
  focusStore.request('terminal');
  const { cols, rows } = getLastTerminalDims();
  traceMark(trace, 'dispatch:start');
  const info = (await pipeline.dispatch('session.open', {
    docPath,
    agentId,
    cols,
    rows,
  })) as SessionInfo | undefined;
  traceMark(trace, 'dispatch:spawned');
  // Hand the trace its sessionId so TerminalView's mount/replay/reveal marks
  // land on the same timeline.
  if (info?.id) bindTraceSession(trace, info.id);
}

/**
 * Spawn a workspace-hub session (terminal parity for sub-workspaces): no
 * FOCUS_DOC, cwd = project root, grouped under the given workspace path
 * (`.iris` = project root). Stage the matching hub view so the new terminal
 * surfaces in the right pane. A hub terminal is ephemeral and intentionally
 * unaware of its sub-workspace — the binding is left-pane grouping only.
 */
export async function openWorkspaceSession(workspacePath: string, agentId: string): Promise<void> {
  const trace = beginTerminalTrace('open', { label: agentId });
  await editorStore.flushBeforeSwitch();
  traceMark(trace, 'flushEditor');
  if (workspacePath === '.iris') await projectStore.selectRoot();
  else await projectStore.selectWorkspace(workspacePath);
  traceMark(trace, 'selectView');
  focusStore.request('terminal');
  const { cols, rows } = getLastTerminalDims();
  traceMark(trace, 'dispatch:start');
  const info = (await pipeline.dispatch('session.open', {
    docPath: null,
    workspacePath,
    agentId,
    cols,
    rows,
  })) as SessionInfo | undefined;
  traceMark(trace, 'dispatch:spawned');
  if (info?.id) bindTraceSession(trace, info.id);
}

export async function closeSession(sessionId: string): Promise<void> {
  await pipeline.dispatch('session.close', { sessionId });
}
