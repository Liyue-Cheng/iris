/**
 * UI actions for sessions. The verb is the session.open / session.close
 * instruction; initial cols/rows come from the last fit() measurement so
 * ConPTY spawns at (or near) the real size — spawn-then-resize makes
 * PowerShell repaint its banner and shreds early progress-bar lines.
 */
import { pipeline } from '@renderer/cpu';
import { getLastTerminalDims } from '@renderer/stores/session-store';

export async function openSession(docPath: string | null, agentId: string): Promise<void> {
  const { cols, rows } = getLastTerminalDims();
  await pipeline.dispatch('session.open', { docPath, agentId, cols, rows });
}

export async function closeSession(sessionId: string): Promise<void> {
  await pipeline.dispatch('session.close', { sessionId });
}
