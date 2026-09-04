import type {
  IrisAgentAnchor,
  IrisAgentCardState,
  IrisAgentCardView,
  IrisAgentModelRef,
  IrisAgentPauseReason,
  IrisAgentRuntimeState,
  IrisAgentSessionProjectionUpdate,
  IrisAgentSessionInfo,
  IrisAgentIntentPatch,
  IrisAgentIntentView,
} from '@shared/types';
import { isDeepStrictEqual } from 'node:util';
import type { AgentToolOperationInput, AgentToolOperationResult } from '@shared/agent-protocol';

export interface AgentSessionAggregate {
  id: string;
  kind: 'iris-agent';
  anchor: IrisAgentAnchor;
  model: IrisAgentModelRef | null;
  parentSessionId?: string;
  forkedFromIntentId?: string;
  projectRoot: string;
  displayName: string;
  state: IrisAgentRuntimeState;
  revision: number;
  workerEpoch: number;
  nextOrdinal: number;
  currentIntentId: string | null;
  stopRequestedIntentId?: string;
  terminalSupervisionAlert?: { terminalId: string; evidence: string; createdAt: number };
  activeIntentIds: string[];
  intents: AgentIntent[];
  turns: AgentTurn[];
  invokes: AgentInvoke[];
  invokeAttempts: AgentInvokeAttempt[];
  timeline: AgentTimelineActivity[];
  toolOperations: AgentToolOperation[];
  effects: AgentEffect[];
  requestFacts: AgentRequestFacts[];
  rewindReceipts: AgentRewindReceipt[];
  injection: AgentInjection;
  createdAt: number;
  updatedAt: number;
  selfHostingEligible: false;
}

export interface AgentIntent {
  id: string;
  content: string;
  turnIds: string[];
  state: 'running' | 'paused' | 'completed' | 'superseded';
  pauseReason?: IrisAgentPauseReason;
  pauseMessage?: string;
  assembledInputAvailable: boolean;
  createdAt: number;
  closedAt?: number;
}

export interface AgentTurn {
  id: string;
  intentId: string;
  invokeId: string;
  state: 'running' | 'settled';
  assistant: {
    content: string;
    toolCalls: Array<{ id: string; tool: AgentToolActivity['tool']; input: unknown }>;
    createdAt: number;
  } | null;
  toolResults: Array<{
    toolCallId: string;
    tool: AgentToolActivity['tool'];
    content: string;
    isError: boolean;
    createdAt: number;
  }>;
  createdAt: number;
  settledAt?: number;
}

export interface AgentInjection {
  methods: { agent: 'current'; software: 'current'; project: 'current' };
  anchor: {
    path: string;
    baselineText: string;
    baselineSha256: string;
    capturedAt: number;
  };
}

export interface AgentToolOperation {
  id: string;
  toolActivityId: string;
  intentId: string;
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
  intentId: string;
  createdAt: number;
  promptFingerprint: string;
  layerFingerprints: {
    agent: string;
    software: string;
    project: string;
    anchor: string;
  };
  anchor: IrisAgentAnchor;
  anchorPatch: Array<{ start: number; deleteCount: number; lines: string[] }>;
  promptChars: number;
  redacted: true;
}

export interface AgentInvoke {
  id: string;
  intentId: string;
  turnId: string;
  index: number;
  state: 'running' | 'completed' | 'failed' | 'aborted';
  attemptIds: string[];
  createdAt: number;
  completedAt?: number;
  error?: string;
}

export interface AgentInvokeAttempt {
  id: string;
  invokeId: string;
  intentId: string;
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
  intentId: string;
  createdAt: number;
}

export interface AgentReplyActivity extends AgentActivityBase {
  kind: 'reply';
  turnId: string;
  invokeId: string;
  invokeAttemptId: string;
  providerMessageId: string;
  state: 'streaming' | 'completed' | 'stopped' | 'failed';
  contextDisposition: 'pending' | 'committed' | 'excluded';
  content: string;
  completedAt?: number;
  error?: string;
}

export interface AgentToolActivity extends AgentActivityBase {
  kind: 'tool';
  turnId: string;
  invokeId: string;
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
  terminalArtifactRef?: string;
  terminalState?: 'running' | 'exited';
  terminalOutcome?: 'success' | 'command-failed' | 'launch-failed' | 'canceled';
  terminalRevealedAt?: number;
  terminalStartedAt?: number;
  terminalCompletedAt?: number;
  terminalExitCode?: number | null;
  terminalSuccessExitCodes?: number[];
  terminalOutputBytes?: number;
  terminalOutputPreview?: string;
  terminalUserInput?: boolean;
  effectIds: string[];
  completedAt?: number;
}

export type AgentTimelineActivity = AgentReplyActivity | AgentToolActivity;

export type AgentEffect = AgentFileEffect | AgentDirectoryEffect | AgentTerminalEffect;

export interface AgentFileEffect {
  id: string;
  intentId: string;
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
  intentId: string;
  turnId: string;
  toolActivityId: string;
  kind: 'directory-create';
  path: string;
  artifactRef: string;
  createdAt: number;
}

export interface AgentTerminalEffect {
  id: string;
  intentId: string;
  turnId: string;
  toolActivityId: string;
  kind: 'terminal-output';
  artifactRef: string;
  createdAt: number;
}

export interface AgentRewindReceipt {
  commandId: string;
  truncatedIntentId: string;
  revertedEffectIds: string[];
  retainedEffectIds: string[];
  createdAt: number;
}

export function createEmptyAgentSession(input: {
  id: string;
  anchor: IrisAgentAnchor;
  model: IrisAgentModelRef | null;
  projectRoot: string;
  displayName: string;
  injection: AgentInjection;
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
    currentIntentId: null,
    activeIntentIds: [],
    intents: [],
    turns: [],
    invokes: [],
    invokeAttempts: [],
    timeline: [],
    toolOperations: [],
    effects: [],
    requestFacts: [],
    rewindReceipts: [],
    injection: structuredClone(input.injection),
    createdAt: input.now,
    updatedAt: input.now,
    selfHostingEligible: false,
  };
}

export function cloneAgentSession(session: AgentSessionAggregate): AgentSessionAggregate {
  return structuredClone(session);
}

export function currentAgentIntent(session: AgentSessionAggregate): AgentIntent | undefined {
  return session.intents.find((intent) => intent.id === session.currentIntentId);
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
  const activeIntent = currentAgentIntent(session);
  const intentsById = new Map(session.intents.map((intent) => [intent.id, intent]));
  const visibleIntents = session.activeIntentIds.flatMap((id) => {
    const intent = intentsById.get(id);
    return intent ? [intent] : [];
  });
  const canRewindLatestIntent = !isAgentSessionBusy(session) && visibleIntents.length > 0;
  return {
    id: session.id,
    kind: 'iris-agent',
    anchor: { ...session.anchor },
    model: session.model ? { ...session.model } : null,
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.forkedFromIntentId ? { forkedFromIntentId: session.forkedFromIntentId } : {}),
    projectRoot: session.projectRoot,
    projectGeneration,
    displayName: session.displayName,
    state: session.state,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    revision: session.revision,
    currentIntentId: session.currentIntentId,
    ...(activeIntent?.state === 'paused'
      ? {
          pause: {
            reason: activeIntent.pauseReason ?? 'runtime',
            message: activeIntent.pauseMessage ?? 'Agent intent paused.',
          },
        }
      : {}),
    ...(session.terminalSupervisionAlert
      ? { supervisionAlert: { ...session.terminalSupervisionAlert } }
      : {}),
    intents: visibleIntents.map((intent) => projectIntent(session, intent)),
    terminals: session.timeline.flatMap((activity) => {
      if (
        activity.kind !== 'tool' || activity.tool !== 'terminal' ||
        !activity.terminalId || !terminalArtifactRef(session, activity) ||
        (!activity.terminalRevealedAt && activity.state === 'running' &&
          activity.terminalState !== 'exited')
      ) return [];
      const terminalExited = activity.terminalState === 'exited' || activity.state !== 'running';
      const terminalOutcome = activity.terminalOutcome ??
        (activity.state === 'canceled'
          ? 'canceled'
          : undefined);
      return [{
        id: activity.terminalId,
        toolActivityId: activity.id,
        command: activity.command ?? activity.inputSummary,
        cwd: activity.cwd ?? activity.path ?? '.',
        revealed: activity.terminalRevealedAt !== undefined,
        state: terminalExited ? 'exited' : 'running',
        ...(terminalOutcome ? { outcome: terminalOutcome } : {}),
        ...(activity.terminalExitCode === undefined ? {} : { exitCode: activity.terminalExitCode }),
        startedAt: activity.terminalStartedAt ?? activity.createdAt,
        ...((activity.terminalCompletedAt ?? activity.completedAt)
          ? { completedAt: activity.terminalCompletedAt ?? activity.completedAt }
          : {}),
        userInput: activity.terminalUserInput ?? false,
      }];
    }),
    canRewindLatestIntent,
    selfHostingEligible: false,
  };
}

function terminalArtifactRef(
  session: AgentSessionAggregate,
  activity: AgentToolActivity,
): string | undefined {
  return activity.terminalArtifactRef ?? session.effects.find(
    (effect) => effect.kind === 'terminal-output' && effect.toolActivityId === activity.id,
  )?.artifactRef;
}

export function diffAgentSessionProjection(
  previous: IrisAgentSessionInfo | null,
  next: IrisAgentSessionInfo,
): IrisAgentSessionProjectionUpdate {
  if (!previous || previous.id !== next.id || previous.revision + 1 !== next.revision) {
    return { kind: 'snapshot', session: structuredClone(next) };
  }
  const intents: IrisAgentIntentPatch[] = [];
  const nextIntentIds = new Set(next.intents.map((intent) => intent.id));
  for (const intent of previous.intents) {
    if (!nextIntentIds.has(intent.id)) intents.push({ operation: 'remove', intentId: intent.id });
  }
  const previousIntents = new Map(previous.intents.map((intent) => [intent.id, intent]));
  for (let index = 0; index < next.intents.length; index += 1) {
    const intent = next.intents[index]!;
    const before = previousIntents.get(intent.id);
    const cardPatches = [] as Extract<IrisAgentIntentPatch, { operation: 'upsert' }>['cards'];
    const nextCardIds = new Set(intent.cards.map((card) => card.id));
    for (const card of before?.cards ?? []) {
      if (!nextCardIds.has(card.id)) cardPatches.push({ operation: 'remove', cardId: card.id });
    }
    const previousCards = new Map((before?.cards ?? []).map((card) => [card.id, card]));
    for (let cardIndex = 0; cardIndex < intent.cards.length; cardIndex += 1) {
      const card = intent.cards[cardIndex]!;
      if (!isDeepStrictEqual(previousCards.get(card.id), card) || before?.cards[cardIndex]?.id !== card.id) {
        cardPatches.push({ operation: 'upsert', index: cardIndex, card: structuredClone(card) });
      }
    }
    const header = intentHeader(intent);
    if (!before || !isDeepStrictEqual(intentHeader(before), header) || cardPatches.length > 0 ||
      previous.intents[index]?.id !== intent.id) {
      intents.push({ operation: 'upsert', index, intent: header, cards: cardPatches });
    }
  }
  return {
    kind: 'patch',
    sessionId: next.id,
    baseRevision: previous.revision,
    revision: next.revision,
    session: sessionHeader(next),
    intents,
  };
}

function sessionHeader(session: IrisAgentSessionInfo): Omit<IrisAgentSessionInfo, 'revision' | 'intents'> {
  const { revision: _revision, intents: _intents, ...header } = session;
  return structuredClone(header);
}

function intentHeader(intent: IrisAgentIntentView): Omit<IrisAgentIntentView, 'cards'> {
  const { cards: _cards, ...header } = intent;
  return structuredClone(header);
}

function projectIntent(
  session: AgentSessionAggregate,
  intent: AgentIntent,
) {
  const activities = session.timeline.filter(
    (activity) => activity.intentId === intent.id,
  );
  const cards = projectCards(activities);
  const invokeCount = session.invokes.filter((invoke) => invoke.intentId === intent.id).length;
  return {
    id: intent.id,
    state: intent.state,
    user: {
      id: `user:${intent.id}`,
      content: intent.content,
      createdAt: intent.createdAt,
      contextAvailable: intent.assembledInputAvailable || invokeCount > 0,
      contextTitle: invokeCount > 0
        ? `Open provider context (${invokeCount} calls)`
        : 'Open assembled input',
    },
    cards,
    canFork: intent.state === 'completed' && isAgentSessionQuiescent(session),
    canForkFromInput: true,
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
      ...(activity.terminalOutputPreview ? { errorDetail: activity.terminalOutputPreview } : {}),
      ...(activity.terminalId ? { terminalId: activity.terminalId } : {}),
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
      state: activity.state,
      ...(activity.error ? { error: activity.error } : {}),
      ...(activity.terminalOutputPreview ? { errorDetail: activity.terminalOutputPreview } : {}),
      ...(activity.terminalId ? { terminalId: activity.terminalId } : {}),
    };
  }
  return {
    id: activity.id,
    kind: 'query' as const,
    label: activity.command ?? activity.inputSummary,
    state: activity.state,
    ...(activity.error ? { error: activity.error } : {}),
    ...(activity.terminalOutputPreview ? { errorDetail: activity.terminalOutputPreview } : {}),
    ...(activity.terminalId ? { terminalId: activity.terminalId } : {}),
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
