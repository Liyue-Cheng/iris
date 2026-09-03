import type { IrisAgentSessionInfo, TerminalSessionInfo, SessionState } from '@shared/types';
import { aggregateDocState } from '@renderer/stores/session-store';

export function agentActivityState(state: IrisAgentSessionInfo['state']): SessionState {
  if (state === 'starting' || state === 'running' || state === 'waiting-tool' || state === 'retry-wait' || state === 'stopping') {
    return 'active';
  }
  return 'idle';
}

export function aggregateCombinedDocState(
  sessions: TerminalSessionInfo[],
  agentSessions: readonly IrisAgentSessionInfo[],
  docPath: string,
): SessionState | null {
  const terminalState = aggregateDocState(sessions, docPath);
  const agentState = agentSessions
    .filter((session) => session.anchor.kind === 'document' && session.anchor.path === docPath)
    .reduce<SessionState | null>((best, session) => {
      const next = agentActivityState(session.state);
      return next === 'active' || best === null ? next : best;
    }, null);
  if (terminalState === 'active' || agentState === 'active') return 'active';
  if (terminalState === 'idle' || agentState === 'idle') return 'idle';
  return terminalState;
}
