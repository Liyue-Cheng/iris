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
import type {
  ProjectScope,
  TerminalSessionInfo,
  SessionListSnapshot,
  SessionState,
} from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { projectScopeState, sameProjectScope } from './project-scope-state';
import { healthStore } from './health-store';

export interface SessionStoreState {
  scope: ProjectScope | null;
  /** insertion-ordered */
  sessions: TerminalSessionInfo[];
  /** Sessions whose input/resize IPC has failed since the last successful I/O. */
  disconnectedSessionIds: ReadonlySet<string>;
}

let state: SessionStoreState = {
  scope: null,
  sessions: [],
  disconnectedSessionIds: new Set(),
};
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

  handleCreated(info: TerminalSessionInfo): void {
    const scope = projectScopeState.get();
    if (
      !scope ||
      info.projectRoot !== scope.root ||
      info.projectGeneration !== scope.generation
    ) {
      return;
    }
    const sessions = [...state.sessions.filter((s) => s.id !== info.id), info];
    setState({ scope, sessions });
  },

  handlePatch(sessionId: string, patch: Partial<TerminalSessionInfo>): void {
    const sessions = state.sessions.map((s) => (s.id === sessionId ? { ...s, ...patch } : s));
    setState({ sessions });
  },

  handleDestroyed(sessionId: string): void {
    const sessions = state.sessions.filter((s) => s.id !== sessionId);
    setState({
      sessions,
      disconnectedSessionIds: new Set(
        [...state.disconnectedSessionIds].filter((id) => id !== sessionId),
      ),
    });
  },

  /** Replace the whole projection with a fresh main-process snapshot
   *  (boot hydration, project open, desync self-heal). */
  reset(
    sessions: TerminalSessionInfo[] = [],
    scope: ProjectScope | null = projectScopeState.get(),
  ): void {
    const filtered = scope
      ? sessions.filter(
          (session) =>
            session.projectRoot === scope.root &&
            session.projectGeneration === scope.generation,
        )
      : [];
    setState({
      scope,
      sessions: filtered,
      disconnectedSessionIds: new Set(
        [...state.disconnectedSessionIds].filter((id) =>
          filtered.some((session) => session.id === id),
        ),
      ),
    });
  },

  markDisconnected(sessionId: string): void {
    if (state.disconnectedSessionIds.has(sessionId)) return;
    setState({ disconnectedSessionIds: new Set(state.disconnectedSessionIds).add(sessionId) });
  },

  clearDisconnected(sessionId: string): void {
    if (!state.disconnectedSessionIds.has(sessionId)) return;
    const next = new Set(state.disconnectedSessionIds);
    next.delete(sessionId);
    setState({ disconnectedSessionIds: next });
  },

  has(sessionId: string): boolean {
    return state.sessions.some((s) => s.id === sessionId);
  },
};

/**
 * Stable grouping key for a session's anchor. Doc sessions key by their doc
 * path; hub sessions (docPath null) key by `ws:<workspacePath>` (root =
 * `.iris`). The `ws:` prefix can never collide with a `.md` doc path, so the
 * two namespaces stay disjoint. This is the load-bearing decoupling: a hub
 * session groups by workspace WITHOUT carrying a FOCUS_DOC.
 */
export function sessionAnchorKey(s: Pick<TerminalSessionInfo, 'docPath' | 'workspacePath'>): string {
  return s.docPath != null ? s.docPath : `ws:${s.workspacePath ?? '.iris'}`;
}

/** Anchor key for a workspace hub (project root = '.iris'). */
export function workspaceAnchorKey(workspacePath: string): string {
  return `ws:${workspacePath}`;
}

/**
 * Pull the authoritative session list from main and reset the projection.
 * The projection is otherwise event-fed only, so every renderer reload
 * (dev full reload, Ctrl+R, crash recovery) starts it empty while the
 * PTY pool lives on — this is the recovery path (issue 2026-06-12
 * 会话投影丢失). Terminal content needs no extra care: TerminalView
 * replays from main's headless mirror on mount.
 */
async function pullSessions(scope: ProjectScope): Promise<void> {
  const snapshot = await window.api.invoke<
    { expectedScope: ProjectScope },
    SessionListSnapshot
  >(CHANNELS.SESSION_LIST, { expectedScope: scope });
  if (!sameProjectScope(scope, projectScopeState.get())) return;
  if (!sameProjectScope(snapshot.scope, scope)) return;
  sessionStore.reset(snapshot.sessions, snapshot.scope);
  healthStore.resolve('session-projection', scope);
}

export async function hydrateSessions(): Promise<boolean> {
  const scope = projectScopeState.get();
  if (!scope) {
    sessionStore.reset([], null);
    return true;
  }
  try {
    await pullSessions(scope);
    return true;
  } catch (err) {
    console.warn('[session-store] hydrate from main failed', err);
    healthStore.degrade({
      key: 'session-projection',
      domain: 'session-projection',
      cause: err,
      scope,
      retry: () => pullSessions(scope),
    });
    return false;
  }
}

export interface TerminalDims {
  cols: number;
  rows: number;
}

/** Geometry buckets with materially different available widths. */
export type TerminalLayoutScope =
  | { kind: 'root-hub' }
  | { kind: 'workspace-hub'; workspacePath: string }
  | { kind: 'doc-right-pane' };

const DEFAULT_TERMINAL_DIMS: TerminalDims = { cols: 120, rows: 30 };

/**
 * Last real terminal dims measured by TerminalView's fit(). The module is
 * instantiated once per renderer window, while the nested maps additionally
 * isolate projects and layout regions. Nothing here is reactive: measurements
 * should not cause a render.
 */
const lastTerminalDimsByProject = new Map<string, Map<string, TerminalDims>>();

function terminalLayoutScopeKey(scope: TerminalLayoutScope): string {
  return scope.kind === 'workspace-hub' ? `${scope.kind}:${scope.workspacePath}` : scope.kind;
}

/** Derive the geometry bucket from the session's immutable anchor. */
export function terminalLayoutScope(
  session: Pick<TerminalSessionInfo, 'docPath' | 'workspacePath'>,
): TerminalLayoutScope {
  if (session.docPath !== null) return { kind: 'doc-right-pane' };
  if (session.workspacePath && session.workspacePath !== '.iris') {
    return { kind: 'workspace-hub', workspacePath: session.workspacePath };
  }
  return { kind: 'root-hub' };
}

export function setLastTerminalDims(
  projectRoot: string,
  scope: TerminalLayoutScope,
  dims: TerminalDims,
): void {
  let projectDims = lastTerminalDimsByProject.get(projectRoot);
  if (!projectDims) {
    projectDims = new Map();
    lastTerminalDimsByProject.set(projectRoot, projectDims);
  }
  projectDims.set(terminalLayoutScopeKey(scope), dims);
}

export function getLastTerminalDims(
  projectRoot: string | null | undefined,
  scope: TerminalLayoutScope,
): TerminalDims {
  if (!projectRoot) return DEFAULT_TERMINAL_DIMS;
  return (
    lastTerminalDimsByProject.get(projectRoot)?.get(terminalLayoutScopeKey(scope)) ??
    DEFAULT_TERMINAL_DIMS
  );
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
 * Aggregate session state under one anchor key for the left-pane dots:
 * any active → 'active'; else any idle → 'idle'; else (exited only) →
 * 'exited'; no sessions → null.
 */
export function aggregateAnchorState(
  sessions: TerminalSessionInfo[],
  anchorKey: string,
): SessionState | null {
  let best: SessionState | null = null;
  for (const s of sessions) {
    if (sessionAnchorKey(s) !== anchorKey) continue;
    if (s.state === 'active') return 'active';
    if (s.state === 'idle') best = 'idle';
    else if (best === null) best = 'exited';
  }
  return best;
}

/** Doc-row dot aggregation — a doc session's anchor key IS its doc path. */
export function aggregateDocState(sessions: TerminalSessionInfo[], docPath: string): SessionState | null {
  return aggregateAnchorState(sessions, docPath);
}
