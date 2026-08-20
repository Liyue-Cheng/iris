import { useSyncExternalStore } from 'react';
import { CHANNELS } from '@shared/protocol';
import type {
  IrisAgentAnchor,
  IrisAgentListSnapshot,
  IrisAgentSessionProjectionUpdate,
  IrisAgentSessionInfo,
  ProjectScope,
} from '@shared/types';
import { projectScopeState, sameProjectScope } from './project-scope-state';
import { healthStore } from './health-store';

export interface IrisAgentStoreState {
  scope: ProjectScope | null;
  sessions: IrisAgentSessionInfo[];
  selectedSessionIdByAnchor: Readonly<Record<string, string>>;
}

let state: IrisAgentStoreState = {
  scope: null,
  sessions: [],
  selectedSessionIdByAnchor: {},
};
const subscribers = new Set<() => void>();

function emit(): void {
  subscribers.forEach((cb) => cb());
}

function setState(patch: Partial<IrisAgentStoreState>): void {
  state = { ...state, ...patch };
  emit();
}

function reconcileSelections(
  sessions: IrisAgentSessionInfo[],
  previous: Readonly<Record<string, string>>,
): Record<string, string> {
  const selections = { ...previous };
  for (const [anchorKey, sessionId] of Object.entries(selections)) {
    const selected = sessions.find((session) => session.id === sessionId);
    if (!selected || irisAgentAnchorKey(selected.anchor) !== anchorKey) delete selections[anchorKey];
  }
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index]!;
    const anchorKey = irisAgentAnchorKey(session.anchor);
    if (!selections[anchorKey]) selections[anchorKey] = session.id;
  }
  return selections;
}

export const irisAgentStore = {
  get(): IrisAgentStoreState {
    return state;
  },

  handleChanged(session: IrisAgentSessionInfo): void {
    const scope = projectScopeState.get();
    if (
      !scope ||
      session.projectRoot !== scope.root ||
      session.projectGeneration !== scope.generation
    ) {
      return;
    }
    const existing = state.sessions.find((item) => item.id === session.id);
    if (existing && existing.revision > session.revision) return;
    const sessions = [...state.sessions.filter((item) => item.id !== session.id), session];
    setState({
      scope,
      sessions,
      selectedSessionIdByAnchor: reconcileSelections(sessions, state.selectedSessionIdByAnchor),
    });
  },

  handleProjectionUpdate(update: IrisAgentSessionProjectionUpdate): 'applied' | 'stale' | 'gap' {
    if (update.kind === 'snapshot') {
      this.handleChanged(update.session);
      return 'applied';
    }
    const existing = state.sessions.find((session) => session.id === update.sessionId);
    if (existing && existing.revision >= update.revision) return 'stale';
    if (!existing || existing.revision !== update.baseRevision) return 'gap';
    const next: IrisAgentSessionInfo = {
      ...structuredClone(update.session),
      revision: update.revision,
      turns: structuredClone(existing.turns),
    };
    for (const turnPatch of update.turns) {
      if (turnPatch.operation === 'remove') {
        next.turns = next.turns.filter((turn) => turn.id !== turnPatch.turnId);
        continue;
      }
      const previousTurn = next.turns.find((turn) => turn.id === turnPatch.turn.id);
      const turn = {
        ...structuredClone(turnPatch.turn),
        cards: structuredClone(previousTurn?.cards ?? []),
      };
      for (const cardPatch of turnPatch.cards) {
        if (cardPatch.operation === 'remove') {
          turn.cards = turn.cards.filter((card) => card.id !== cardPatch.cardId);
          continue;
        }
        turn.cards = upsertAt(
          turn.cards.filter((card) => card.id !== cardPatch.card.id),
          cardPatch.index,
          structuredClone(cardPatch.card),
        );
      }
      next.turns = upsertAt(
        next.turns.filter((candidate) => candidate.id !== turn.id),
        turnPatch.index,
        turn,
      );
    }
    this.handleChanged(next);
    return 'applied';
  },

  handleDestroyed(sessionId: string): void {
    const destroyed = state.sessions.find((session) => session.id === sessionId);
    const sessions = state.sessions.filter((session) => session.id !== sessionId);
    const destroyedKey = destroyed ? irisAgentAnchorKey(destroyed.anchor) : undefined;
    const sibling = destroyedKey
      ? [...sessions].reverse().find((session) => irisAgentAnchorKey(session.anchor) === destroyedKey)
      : undefined;
    const selections = { ...state.selectedSessionIdByAnchor };
    if (destroyedKey && selections[destroyedKey] === sessionId) {
      if (sibling) selections[destroyedKey] = sibling.id;
      else delete selections[destroyedKey];
    }
    setState({
      sessions,
      selectedSessionIdByAnchor: reconcileSelections(sessions, selections),
    });
  },

  reset(
    sessions: IrisAgentSessionInfo[] = [],
    scope: ProjectScope | null = projectScopeState.get(),
  ): void {
    const scopeChanged = !scope || !sameProjectScope(state.scope, scope);
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
      selectedSessionIdByAnchor: reconcileSelections(
        filtered,
        scopeChanged ? {} : state.selectedSessionIdByAnchor,
      ),
    });
  },

  select(sessionId: string): boolean {
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return false;
    setState({
      selectedSessionIdByAnchor: {
        ...state.selectedSessionIdByAnchor,
        [irisAgentAnchorKey(session.anchor)]: sessionId,
      },
    });
    return true;
  },

  has(sessionId: string): boolean {
    return state.sessions.some((session) => session.id === sessionId);
  },
};

function upsertAt<T>(items: T[], index: number, value: T): T[] {
  const next = [...items];
  next.splice(Math.min(Math.max(index, 0), next.length), 0, value);
  return next;
}

async function pullIrisAgentSessions(scope: ProjectScope): Promise<void> {
  const snapshot = await window.api.invoke<
    { expectedScope: ProjectScope },
    IrisAgentListSnapshot
  >(CHANNELS.IRIS_AGENT_LIST, { expectedScope: scope });
  if (!sameProjectScope(scope, projectScopeState.get())) return;
  if (!sameProjectScope(snapshot.scope, scope)) return;
  irisAgentStore.reset(snapshot.sessions, snapshot.scope);
  healthStore.resolve('iris-agent-projection', scope);
}

export async function hydrateIrisAgentSessions(): Promise<boolean> {
  const scope = projectScopeState.get();
  if (!scope) {
    irisAgentStore.reset([], null);
    return true;
  }
  try {
    await pullIrisAgentSessions(scope);
    return true;
  } catch (err) {
    console.warn('[iris-agent-store] hydrate from main failed', err);
    healthStore.degrade({
      key: 'iris-agent-projection',
      domain: 'session-projection',
      cause: err,
      scope,
      retry: () => pullIrisAgentSessions(scope),
    });
    return false;
  }
}

export function irisAgentAnchorKey(anchor: IrisAgentAnchor): string {
  return anchor.kind === 'document' ? anchor.path : 'ws:' + anchor.path;
}

export function selectedIrisAgentIdForAnchor(anchorKey: string): string | null {
  const selectedSessionId = state.selectedSessionIdByAnchor[anchorKey];
  if (
    selectedSessionId &&
    state.sessions.some(
      (session) => session.id === selectedSessionId && irisAgentAnchorKey(session.anchor) === anchorKey,
    )
  ) {
    return selectedSessionId;
  }
  return (
    [...state.sessions].reverse().find((session) => irisAgentAnchorKey(session.anchor) === anchorKey)?.id ??
    null
  );
}

export function useIrisAgentSessions(): IrisAgentStoreState {
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
