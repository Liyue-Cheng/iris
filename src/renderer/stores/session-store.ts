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
import { CHANNELS } from '@shared/protocol';

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
    const destroyed = state.sessions.find((s) => s.id === sessionId);
    const sessions = state.sessions.filter((s) => s.id !== sessionId);
    // Fallback prefers a sibling under the same doc anchor — the right
    // pane's list is filtered by anchor, so jumping to another doc's
    // session would land on an invisible row.
    const sibling = destroyed
      ? [...sessions].reverse().find((s) => s.docPath === destroyed.docPath)
      : undefined;
    setState({
      sessions,
      activeSessionId:
        state.activeSessionId === sessionId
          ? (sibling?.id ?? sessions[sessions.length - 1]?.id ?? null)
          : state.activeSessionId,
    });
  },

  select(sessionId: string): void {
    if (state.sessions.some((s) => s.id === sessionId)) {
      setState({ activeSessionId: sessionId });
    }
  },

  /**
   * Doc↔terminal linkage: when a doc is selected on the left, stage its
   * best session — state priority active > idle > exited, ties go to the
   * most recently created (sessions[] is insertion-ordered). No session
   * under this anchor → null, which the right pane renders as the
   * doc-anchored launcher panel. Manual select() stands until the next
   * doc selection.
   */
  syncToDoc(docPath: string): void {
    setState({ activeSessionId: bestUnderAnchor(docPath)?.id ?? null });
  },

  /** Root-node linkage: stage the best project-root session (anchor null). */
  syncToRoot(): void {
    setState({ activeSessionId: bestUnderAnchor(null)?.id ?? null });
  },

  /** Replace the whole projection with a fresh main-process snapshot
   *  (boot hydration, project open, desync self-heal). */
  reset(sessions: SessionInfo[] = []): void {
    setState({ sessions, activeSessionId: sessions[sessions.length - 1]?.id ?? null });
  },

  has(sessionId: string): boolean {
    return state.sessions.some((s) => s.id === sessionId);
  },
};

/** Best session under one anchor: active > idle > exited, ties to newest. */
function bestUnderAnchor(docPath: string | null): SessionInfo | null {
  const rank: Record<SessionState, number> = { active: 2, idle: 1, exited: 0 };
  let best: SessionInfo | null = null;
  for (const s of state.sessions) {
    if (s.docPath !== docPath) continue;
    if (!best || rank[s.state] >= rank[best.state]) best = s;
  }
  return best;
}

/**
 * Pull the authoritative session list from main and reset the projection.
 * The projection is otherwise event-fed only, so every renderer reload
 * (dev full reload, Ctrl+R, crash recovery) starts it empty while the
 * PTY pool lives on — this is the recovery path (issue 2026-06-12
 * 会话投影丢失). Terminal content needs no extra care: TerminalView
 * replays from main's headless mirror on mount.
 */
export async function hydrateSessions(): Promise<void> {
  try {
    const sessions = await window.api.invoke<undefined, SessionInfo[]>(CHANNELS.SESSION_LIST);
    sessionStore.reset(sessions);
  } catch (err) {
    console.warn('[session-store] hydrate from main failed', err);
  }
}

/**
 * Last real terminal dims measured by TerminalView's fit(). New sessions
 * spawn with these instead of a placeholder, so ConPTY never sees a
 * spawn-then-resize (banner repaint / progress-bar reflow junk — Marina
 * 用户勘误 #2). Module-level, not store state: nothing re-renders on it.
 */
let lastTerminalDims: { cols: number; rows: number } = { cols: 120, rows: 30 };

export function setLastTerminalDims(dims: { cols: number; rows: number }): void {
  lastTerminalDims = dims;
}

export function getLastTerminalDims(): { cols: number; rows: number } {
  return lastTerminalDims;
}

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
