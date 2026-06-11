/**
 * UI actions for sessions. The verb is the session.open / session.close
 * instruction; initial cols/rows are placeholders — TerminalView's first
 * fit() corrects them within one frame of mounting.
 */
import { pipeline } from '@renderer/cpu';

export async function openSession(docPath: string | null, agentId: string): Promise<void> {
  await pipeline.dispatch('session.open', { docPath, agentId, cols: 120, rows: 30 });
}

export async function closeSession(sessionId: string): Promise<void> {
  await pipeline.dispatch('session.close', { sessionId });
}
