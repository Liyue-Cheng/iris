import type { IrisAgentSessionInfo, TerminalSessionInfo } from '@shared/types';
import { agentActivityState } from './agent-session-state';
import { useSessions } from '@renderer/stores/session-store';
import { useIrisAgentSessions } from '@renderer/stores/iris-agent-store';

export type SessionKind = 'terminal' | 'iris-agent';
export type SessionKey = `${SessionKind}:${string}`;

export type SessionAnchor =
  | { kind: 'document'; path: string }
  | { kind: 'workspace'; path: string };
export type SessionActivity = 'active' | 'idle' | 'exited';

export interface SessionProjection {
  key: SessionKey;
  kind: SessionKind;
  id: string;
  anchor: SessionAnchor;
  title: string;
  subtitle: string;
  indicator: SessionActivity;
  busy: boolean;
  createdAt: number;
  updatedAt: number;
  capabilities: {
    close: boolean;
    select: boolean;
  };
}

export function terminalSessionKey(id: string): SessionKey {
  return `terminal:${id}`;
}

export function irisAgentSessionKey(id: string): SessionKey {
  return `iris-agent:${id}`;
}

export function sessionProjectionAnchorKey(anchor: SessionAnchor): string {
  return anchor.kind === 'document' ? anchor.path : `ws:${anchor.path}`;
}

export function terminalSessionProjection(session: TerminalSessionInfo): SessionProjection {
  const anchor: SessionAnchor = session.docPath !== null
    ? { kind: 'document', path: session.docPath }
    : { kind: 'workspace', path: session.workspacePath ?? '.iris' };
  return {
    key: terminalSessionKey(session.id),
    kind: 'terminal',
    id: session.id,
    anchor,
    title: session.terminalTitle ?? session.displayName,
    subtitle: session.displayName,
    indicator: session.state,
    busy: session.state === 'active',
    createdAt: session.createdAt,
    updatedAt: session.exitedAt ?? session.createdAt,
    capabilities: { close: true, select: true },
  };
}

export function irisAgentSessionProjection(session: IrisAgentSessionInfo): SessionProjection {
  const anchor: SessionAnchor = session.anchor.kind === 'document'
    ? { kind: 'document', path: session.anchor.path }
    : { kind: 'workspace', path: session.anchor.path };
  const indicator = agentActivityState(session.state);
  return {
    key: irisAgentSessionKey(session.id),
    kind: 'iris-agent',
    id: session.id,
    anchor,
    title: session.displayName,
    subtitle: 'Iris Agent',
    indicator,
    busy: indicator === 'active',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    capabilities: { close: true, select: true },
  };
}

export function projectSessions(
  terminals: readonly TerminalSessionInfo[],
  agents: readonly IrisAgentSessionInfo[],
): SessionProjection[] {
  return [
    ...terminals.map(terminalSessionProjection),
    ...agents.map(irisAgentSessionProjection),
  ].sort((a, b) => a.createdAt - b.createdAt);
}

/** React-facing read model shared by every session-aware surface. */
export function useSessionProjections(anchorKey?: string): SessionProjection[] {
  const projections = useSessionProjectionState().projections;
  return anchorKey === undefined
    ? projections
    : projections.filter((session) => sessionProjectionAnchorKey(session.anchor) === anchorKey);
}

/** Combined read model plus domain records needed by the selected renderer. */
export function useSessionProjectionState(): {
  projections: SessionProjection[];
  terminalSessions: readonly TerminalSessionInfo[];
  agentSessions: readonly IrisAgentSessionInfo[];
} {
  const { sessions: terminals } = useSessions();
  const { sessions: agents } = useIrisAgentSessions();
  return {
    projections: projectSessions(terminals, agents),
    terminalSessions: terminals,
    agentSessions: agents,
  };
}

export function aggregateProjectionState(
  sessions: readonly SessionProjection[],
  anchorKey: string,
): SessionProjection['indicator'] | null {
  let best: SessionProjection['indicator'] | null = null;
  for (const session of sessions) {
    if (sessionProjectionAnchorKey(session.anchor) !== anchorKey) continue;
    if (session.indicator === 'active') return 'active';
    if (session.indicator === 'idle') best = 'idle';
    else if (best === null) best = 'exited';
  }
  return best;
}
