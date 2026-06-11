/**
 * @file stores/session-store.ts
 * @purpose Session projection: the renderer-side mirror of the main-process
 *   session pool, plus the right pane's selection. State arrives from
 *   session.open commits and the evt:session:* broadcasts.
 *
 * PTY OUTPUT does not pass through here — TerminalView subscribes to
 * evt:session:output directly (a store re-render per byte burst would be
 * absurd). This store carries lifecycle + state only.
 */
import { useSyncExternalStore } from 'react';
import type { SessionInfo, SessionState } from '@shared/types';

export interface SessionStoreState {
  /** insertion-ordered */
  sessions: SessionInfo[];
  /** Session shown in the right pane (null = none). */
  activeSessionId: string | null;
}

let state: SessionStoreState = { sessions: [], activeSessionId: null };
const subscribers = new Set<() => void>();

function emit(): void {
  subscribers.forEach((cb) => cb());
}

function setState(patch: Partial<SessionStoreState>): void {
  state = { ...state, ...patch };
  emit();
}

export const sessionStore = {
  get(): SessionStoreState {
    return state;
  },

  handleCreated(info: SessionInfo): void {
    setState({
      sessions: [...state.sessions.filter((s) => s.id !== info.id), info],
      activeSessionId: info.id, // a fresh session takes the stage
    });
  },

  handlePatch(sessionId: string, patch: Partial<SessionInfo>): void {
    setState({
      sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, ...patch } : s)),
    });
  },

  handleDestroyed(sessionId: string): void {
    const sessions = state.sessions.filter((s) => s.id !== sessionId);
    setState({
      sessions,
      activeSessionId:
        state.activeSessionId === sessionId
          ? (sessions[sessions.length - 1]?.id ?? null)
          : state.activeSessionId,
    });
  },

  select(sessionId: string): void {
    if (state.sessions.some((s) => s.id === sessionId)) {
      setState({ activeSessionId: sessionId });
    }
  },

  /** Project switch: main killed nothing (sessions belong to the app run),
   *  but anchors point into another project — reset the projection. */
  reset(sessions: SessionInfo[] = []): void {
    setState({ sessions, activeSessionId: sessions[sessions.length - 1]?.id ?? null });
  },
};

export function useSessions(): SessionStoreState {
  return useSyncExternalStore(
    (onStoreChange) => {
      subscribers.add(onStoreChange);
      return () => {
        subscribers.delete(onStoreChange);
      };
    },
    () => state,
  );
}

/**
 * Aggregate session state per doc anchor for the left-pane dots:
 * any active → 'active'; else any idle → 'idle'; else (exited only) →
 * 'exited'; no sessions → null.
 */
export function aggregateDocState(sessions: SessionInfo[], docPath: string): SessionState | null {
  let best: SessionState | null = null;
  for (const s of sessions) {
    if (s.docPath !== docPath) continue;
    if (s.state === 'active') return 'active';
    if (s.state === 'idle') best = 'idle';
    else if (best === null) best = 'exited';
  }
  return best;
}
