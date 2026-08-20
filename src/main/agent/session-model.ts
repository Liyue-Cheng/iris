import type {
  IrisAgentAnchor,
  IrisAgentCardState,
  IrisAgentCardView,
  IrisAgentModelRef,
  IrisAgentPauseReason,
  IrisAgentRuntimeState,
  IrisAgentSessionProjectionUpdate,
  IrisAgentSessionInfo,
  IrisAgentTurnPatch,
  IrisAgentTurnView,
} from '@shared/types';
import { isDeepStrictEqual } from 'node:util';
import type { AgentToolOperationInput, AgentToolOperationResult } from '@shared/agent-protocol';

export interface AgentSessionAggregate {
  id: string;
  kind: 'iris-agent';
  anchor: IrisAgentAnchor;
  model: IrisAgentModelRef | null;
  parentSessionId?: string;
  forkedFromTurnId?: string;
  projectRoot: string;
  displayName: string;
  state: IrisAgentRuntimeState;
  revision: number;
  workerEpoch: number;
  nextOrdinal: number;
  currentTurnId: string | null;
  stopRequestedTurnId?: string;
  turns: AgentTurn[];
  providerCalls: AgentProviderCall[];
  providerAttempts: AgentProviderAttempt[];
  timeline: AgentTimelineActivity[];
  toolOperations: AgentToolOperation[];
  transcript: AgentProviderFrame[];
  effects: AgentEffect[];
  requestFacts: AgentRequestFacts[];
  undoReceipts: AgentUndoReceipt[];
  createdAt: number;
  updatedAt: number;
  selfHostingEligible: false;
}

export interface AgentToolOperation {
  id: string;
  toolActivityId: string;
  turnId: string;
  input: AgentToolOperationInput;
  state: 'running' | 'completed' | 'failed';
  result?: AgentToolOperationResult;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface AgentRequestFacts {
  id: string;
  turnId: string;
  createdAt: number;
  promptFingerprint: string;
  layerFingerprints: {
    agent: string;
    software: string;
    project: string;
    anchor: string;
  };
  anchor: IrisAgentAnchor;
  promptChars: number;
  redacted: true;
}

export interface AgentTurn {
  id: string;
  userActivityId: string;
  state: 'running' | 'pausing' | 'paused' | 'fulfilled' | 'abandoned' | 'removed';
  pauseReason?: IrisAgentPauseReason;
  error?: string;
  assembledInputAvailable: boolean;
  createdAt: number;
  closedAt?: number;
}

export interface AgentProviderCall {
  id: string;
  turnId: string;
  index: number;
  state: 'running' | 'completed' | 'failed' | 'aborted';
  attemptIds: string[];
  createdAt: number;
  completedAt?: number;
  error?: string;
}

export interface AgentProviderAttempt {
  id: string;
  providerCallId: string;
  turnId: string;
  index: number;
  state: 'running' | 'completed' | 'failed' | 'aborted';
  createdAt: number;
  completedAt?: number;
  error?: string;
}

interface AgentActivityBase {
  id: string;
  ordinal: number;
  turnId: string;
  createdAt: number;
}

export interface AgentUserActivity extends AgentActivityBase {
  kind: 'user';
  content: string;
  assembledInputArtifactId: string;
}

export interface AgentReplyActivity extends AgentActivityBase {
  kind: 'reply';
  providerCallId: string;
  providerAttemptId: string;
  providerMessageId: string;
  state: 'streaming' | 'completed' | 'stopped' | 'failed';
  contextDisposition: 'pending' | 'committed' | 'excluded';
  content: string;
  completedAt?: number;
  error?: string;
}

export interface AgentToolActivity extends AgentActivityBase {
  kind: 'tool';
  providerCallId: string;
  toolCallId: string;
  tool: 'read' | 'edit' | 'write' | 'terminal';
  intent?: 'information' | 'operation';
  state: 'running' | 'completed' | 'failed' | 'canceled';
  inputSummary: string;
  operation?: 'access' | 'readFile' | 'writeFile' | 'mkdir' | 'exec';
  command?: string;
  cwd?: string;
  resultSummary?: string;
  error?: string;
  diff?: string;
  path?: string;
  terminalId?: string;
  effectIds: string[];
  completedAt?: number;
}

export type AgentTimelineActivity = AgentUserActivity | AgentReplyActivity | AgentToolActivity;

interface AgentProviderFrameBase {
  id: string;
  turnId: string;
  content: string;
  providerMessage?: Record<string, unknown>;
  createdAt: number;
}

export type AgentProviderFrame =
  | (AgentProviderFrameBase & { role: 'user' })
  | (AgentProviderFrameBase & { role: 'assistant'; providerCallId: string })
  | (AgentProviderFrameBase & { role: 'tool'; toolCallId: string });

export type AgentEffect = AgentFileEffect | AgentDirectoryEffect | AgentTerminalEffect;

export interface AgentFileEffect {
  id: string;
  turnId: string;
  toolActivityId: string;
  kind: 'file-write';
  path: string;
  operation: 'edit' | 'write';
  beforeSha256: string | null;
  afterSha256: string;
  artifactRef: string;
  createdAt: number;
}

export interface AgentDirectoryEffect {
  id: string;
  turnId: string;
  toolActivityId: string;
  kind: 'directory-create';
  path: string;
  artifactRef: string;
  createdAt: number;
}

export interface AgentTerminalEffect {
  id: string;
  turnId: string;
  toolActivityId: string;
  kind: 'terminal-output';
  artifactRef: string;
  createdAt: number;
}

export interface AgentUndoReceipt {
  commandId: string;
  removedTurnId: string;
  removedAt: number;
  externalEffectsRetained: true;
}

export function createEmptyAgentSession(input: {
  id: string;
  anchor: IrisAgentAnchor;
  model: IrisAgentModelRef | null;
  projectRoot: string;
  displayName: string;
  now: number;
}): AgentSessionAggregate {
  return {
    id: input.id,
    kind: 'iris-agent',
    anchor: { ...input.anchor },
    model: input.model ? { ...input.model } : null,
    projectRoot: input.projectRoot,
    displayName: input.displayName,
    state: 'ready',
    revision: 0,
    workerEpoch: 0,
    nextOrdinal: 1,
    currentTurnId: null,
    turns: [],
    providerCalls: [],
    providerAttempts: [],
    timeline: [],
    toolOperations: [],
    transcript: [],
    effects: [],
    requestFacts: [],
    undoReceipts: [],
    createdAt: input.now,
    updatedAt: input.now,
    selfHostingEligible: false,
  };
}

export function cloneAgentSession(session: AgentSessionAggregate): AgentSessionAggregate {
  return structuredClone(session);
}

export function currentAgentTurn(session: AgentSessionAggregate): AgentTurn | undefined {
  return session.turns.find((turn) => turn.id === session.currentTurnId);
}

export function isAgentSessionBusy(session: AgentSessionAggregate): boolean {
  return session.state === 'starting' || session.state === 'running' ||
    session.state === 'waiting-tool' || session.state === 'retry-wait' || session.state === 'stopping';
}

export function isAgentSessionQuiescent(session: AgentSessionAggregate): boolean {
  return !isAgentSessionBusy(session);
}

export function projectAgentSession(
  session: AgentSessionAggregate,
  projectGeneration: number,
): IrisAgentSessionInfo {
  const activeTurn = currentAgentTurn(session);
  const visibleTurns = session.turns.filter(
    (turn): turn is AgentTurn & { state: Exclude<AgentTurn['state'], 'removed'> } => turn.state !== 'removed',
  );
  const canUndoLatestTurn = !isAgentSessionBusy(session) && visibleTurns.length > 0;
  return {
    id: session.id,
    kind: 'iris-agent',
    anchor: { ...session.anchor },
    model: session.model ? { ...session.model } : null,
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.forkedFromTurnId ? { forkedFromTurnId: session.forkedFromTurnId } : {}),
    projectRoot: session.projectRoot,
    projectGeneration,
    displayName: session.displayName,
    state: session.state,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    revision: session.revision,
    currentTurnId: session.currentTurnId,
    ...(activeTurn?.state === 'paused'
      ? {
          pause: {
            reason: activeTurn.pauseReason ?? 'runtime',
            message: activeTurn.error ?? 'Agent turn paused.',
          },
        }
      : {}),
    turns: visibleTurns.map((turn) => projectTurn(session, turn)),
    canUndoLatestTurn,
    selfHostingEligible: false,
  };
}

export function diffAgentSessionProjection(
  previous: IrisAgentSessionInfo | null,
  next: IrisAgentSessionInfo,
): IrisAgentSessionProjectionUpdate {
  if (!previous || previous.id !== next.id || previous.revision + 1 !== next.revision) {
    return { kind: 'snapshot', session: structuredClone(next) };
  }
  const turns: IrisAgentTurnPatch[] = [];
  const nextTurnIds = new Set(next.turns.map((turn) => turn.id));
  for (const turn of previous.turns) {
    if (!nextTurnIds.has(turn.id)) turns.push({ operation: 'remove', turnId: turn.id });
  }
  const previousTurns = new Map(previous.turns.map((turn) => [turn.id, turn]));
  for (let index = 0; index < next.turns.length; index += 1) {
    const turn = next.turns[index]!;
    const before = previousTurns.get(turn.id);
    const cardPatches = [] as Extract<IrisAgentTurnPatch, { operation: 'upsert' }>['cards'];
    const nextCardIds = new Set(turn.cards.map((card) => card.id));
    for (const card of before?.cards ?? []) {
      if (!nextCardIds.has(card.id)) cardPatches.push({ operation: 'remove', cardId: card.id });
    }
    const previousCards = new Map((before?.cards ?? []).map((card) => [card.id, card]));
    for (let cardIndex = 0; cardIndex < turn.cards.length; cardIndex += 1) {
      const card = turn.cards[cardIndex]!;
      if (!isDeepStrictEqual(previousCards.get(card.id), card) || before?.cards[cardIndex]?.id !== card.id) {
        cardPatches.push({ operation: 'upsert', index: cardIndex, card: structuredClone(card) });
      }
    }
    const header = turnHeader(turn);
    if (!before || !isDeepStrictEqual(turnHeader(before), header) || cardPatches.length > 0 ||
      previous.turns[index]?.id !== turn.id) {
      turns.push({ operation: 'upsert', index, turn: header, cards: cardPatches });
    }
  }
  return {
    kind: 'patch',
    sessionId: next.id,
    baseRevision: previous.revision,
    revision: next.revision,
    session: sessionHeader(next),
    turns,
  };
}

function sessionHeader(session: IrisAgentSessionInfo): Omit<IrisAgentSessionInfo, 'revision' | 'turns'> {
  const { revision: _revision, turns: _turns, ...header } = session;
  return structuredClone(header);
}

function turnHeader(turn: IrisAgentTurnView): Omit<IrisAgentTurnView, 'cards'> {
  const { cards: _cards, ...header } = turn;
  return structuredClone(header);
}

function projectTurn(
  session: AgentSessionAggregate,
  turn: AgentTurn & { state: Exclude<AgentTurn['state'], 'removed'> },
) {
  const user = session.timeline.find(
    (activity): activity is AgentUserActivity => activity.id === turn.userActivityId && activity.kind === 'user',
  );
  if (!user) throw new Error('Agent turn references a missing user activity.');
  const activities = session.timeline.filter(
    (activity) => activity.turnId === turn.id && activity.kind !== 'user',
  );
  const cards = projectCards(activities);
  const providerCallCount = session.providerCalls.filter((call) => call.turnId === turn.id).length;
  return {
    id: turn.id,
    state: turn.state === 'fulfilled' || turn.state === 'abandoned'
      ? turn.state
      : 'active' as const,
    user: {
      id: user.id,
      content: user.content,
      createdAt: user.createdAt,
      contextAvailable: turn.assembledInputAvailable || providerCallCount > 0,
      contextTitle: providerCallCount > 0
        ? `Open provider context (${providerCallCount} calls)`
        : 'Open assembled input',
    },
    cards,
    canFork: turn.state === 'fulfilled' && isAgentSessionQuiescent(session),
  };
}

export function projectCards(activities: AgentTimelineActivity[]): IrisAgentCardView[] {
  const cards: IrisAgentCardView[] = [];
  for (const activity of activities) {
    if (activity.kind === 'reply') {
      cards.push({
        kind: 'agent-reply',
        id: activity.id,
        state: activity.state === 'streaming' ? 'running' : activity.state,
        content: activity.content,
        ...(activity.error ? { error: activity.error } : {}),
        excludedFromContext: activity.contextDisposition === 'excluded',
      });
      continue;
    }
    if (activity.kind !== 'tool') continue;
    if (isLocalRetrieval(activity)) {
      const item = localRetrievalItem(activity);
      const previous = cards[cards.length - 1];
      if (previous?.kind === 'local-retrieval') {
        previous.items.push(item);
        previous.state = combinedState(previous.items.map((candidate) => candidate.state));
      } else {
        cards.push({
          kind: 'local-retrieval',
          id: activity.id,
          state: toolCardState(activity.state),
          items: [item],
        });
      }
      continue;
    }
    if (activity.tool === 'edit' || activity.tool === 'write') {
      const action = fileAction(activity);
      cards.push({
        kind: 'file-change',
        id: activity.id,
        state: activity.state === 'failed'
          ? 'failed'
          : action === 'unchanged'
            ? 'unchanged'
            : toolCardState(activity.state),
        path: activity.path ?? pathFromInputSummary(activity.inputSummary),
        action,
        ...(activity.diff ? { diff: activity.diff } : {}),
        ...(activity.resultSummary ? { detail: activity.resultSummary } : {}),
        ...(activity.error ? { error: activity.error } : {}),
      });
      continue;
    }
    cards.push({
      kind: 'terminal-operation',
      id: activity.id,
      state: toolCardState(activity.state),
      command: activity.command ?? activity.inputSummary,
      cwd: activity.cwd ?? activity.path ?? '.',
      ...(activity.resultSummary ? { detail: activity.resultSummary } : {}),
      ...(activity.error ? { error: activity.error } : {}),
    });
  }
  return cards;
}

function isLocalRetrieval(activity: AgentToolActivity): boolean {
  return activity.tool === 'read' || (activity.tool === 'terminal' && activity.intent === 'information');
}

function localRetrievalItem(activity: AgentToolActivity) {
  if (activity.tool === 'read') {
    return {
      id: activity.id,
      kind: 'file' as const,
      label: activity.path ?? pathFromInputSummary(activity.inputSummary),
      ...(activity.resultSummary ? { detail: activity.resultSummary } : {}),
      state: activity.state,
      ...(activity.error ? { error: activity.error } : {}),
    };
  }
  return {
    id: activity.id,
    kind: 'query' as const,
    label: activity.command ?? activity.inputSummary,
    path: activity.cwd ?? activity.path ?? '.',
    ...(activity.resultSummary ? { detail: activity.resultSummary } : {}),
    state: activity.state,
    ...(activity.error ? { error: activity.error } : {}),
  };
}

function combinedState(states: Array<AgentToolActivity['state']>): IrisAgentCardState {
  if (states.includes('running')) return 'running';
  if (states.includes('failed')) return states.every((state) => state === 'failed') ? 'failed' : 'partial';
  if (states.includes('canceled')) return 'stopped';
  return 'completed';
}

function toolCardState(state: AgentToolActivity['state']): IrisAgentCardState {
  if (state === 'canceled') return 'stopped';
  return state;
}

function fileAction(activity: AgentToolActivity): Extract<
  IrisAgentCardView,
  { kind: 'file-change' }
>['action'] {
  if (activity.resultSummary === 'created') return 'created';
  if (activity.resultSummary === 'updated') return 'updated';
  if (activity.resultSummary === 'unchanged') return 'unchanged';
  return 'attempted';
}

function pathFromInputSummary(summary: string): string {
  const space = summary.indexOf(' ');
  return space >= 0 ? summary.slice(space + 1) : summary;
}
