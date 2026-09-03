import type { SessionProjection } from './session-projection';
import { closeSession } from './session-actions';
import { closeIrisAgent } from './iris-agent-actions';
import type { SessionCloseOutcome } from './session-close-outcome';

/** Dispatches UI lifecycle commands without leaking domain branches into views. */
export function closeProjectedSession(
  session: Pick<SessionProjection, 'kind' | 'id'>,
): Promise<SessionCloseOutcome> {
  return session.kind === 'terminal' ? closeSession(session.id) : closeIrisAgent(session.id);
}
