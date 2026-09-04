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
}

let state: IrisAgentStoreState = {
  scope: null,
  sessions: [],
};
const subscribers = new Set<() => void>();

function emit(): void {
  subscribers.forEach((cb) => cb());
}

function setState(patch: Partial<IrisAgentStoreState>): void {
  state = { ...state, ...patch };
  emit();
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
    setState({ scope, sessions });
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
      intents: structuredClone(existing.intents),
    };
    for (const intentPatch of update.intents) {
      if (intentPatch.operation === 'remove') {
        next.intents = next.intents.filter((intent) => intent.id !== intentPatch.intentId);
        continue;
      }
      const previousIntent = next.intents.find((intent) => intent.id === intentPatch.intent.id);
      const intent = {
        ...structuredClone(intentPatch.intent),
        cards: structuredClone(previousIntent?.cards ?? []),
      };
      for (const cardPatch of intentPatch.cards) {
        if (cardPatch.operation === 'remove') {
          intent.cards = intent.cards.filter((card) => card.id !== cardPatch.cardId);
          continue;
        }
        intent.cards = upsertAt(
          intent.cards.filter((card) => card.id !== cardPatch.card.id),
          cardPatch.index,
          structuredClone(cardPatch.card),
        );
      }
      next.intents = upsertAt(
        next.intents.filter((candidate) => candidate.id !== intent.id),
        intentPatch.index,
        intent,
      );
    }
    this.handleChanged(next);
    return 'applied';
  },

  handleDestroyed(sessionId: string): void {
    const sessions = state.sessions.filter((session) => session.id !== sessionId);
    setState({ sessions });
  },

  reset(
    sessions: IrisAgentSessionInfo[] = [],
    scope: ProjectScope | null = projectScopeState.get(),
  ): void {
    const filtered = scope
      ? sessions.filter(
          (session) =>
            session.projectRoot === scope.root &&
            session.projectGeneration === scope.generation,
        )
      : [];
    setState({ scope, sessions: filtered });
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
