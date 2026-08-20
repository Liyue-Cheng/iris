import { isDeepStrictEqual } from 'node:util';
import type {
  AgentEffect,
  AgentProviderAttempt,
  AgentProviderCall,
  AgentProviderFrame,
  AgentRequestFacts,
  AgentSessionAggregate,
  AgentTimelineActivity,
  AgentToolOperation,
  AgentTurn,
  AgentUndoReceipt,
} from './session-model';
import { cloneAgentSession } from './session-model';

export type AgentEntityCollection =
  | 'turns'
  | 'providerCalls'
  | 'providerAttempts'
  | 'timeline'
  | 'toolOperations'
  | 'transcript'
  | 'effects'
  | 'requestFacts'
  | 'undoReceipts';

export type AgentSessionEntity =
  | AgentTurn
  | AgentProviderCall
  | AgentProviderAttempt
  | AgentTimelineActivity
  | AgentToolOperation
  | AgentProviderFrame
  | AgentEffect
  | AgentRequestFacts
  | AgentUndoReceipt;

type AgentSessionScalars = Omit<AgentSessionAggregate, AgentEntityCollection>;

export type AgentDomainEvent =
  | { type: 'session.created'; session: AgentSessionAggregate }
  | { type: 'session.updated'; patch: Partial<AgentSessionScalars>; removedKeys: string[] }
  | { type: 'entity.upserted'; collection: AgentEntityCollection; entity: AgentSessionEntity }
  | { type: 'entity.removed'; collection: AgentEntityCollection; entityId: string };

export interface AgentDomainTransaction {
  events: AgentDomainEvent[];
}

const COLLECTIONS: AgentEntityCollection[] = [
  'turns',
  'providerCalls',
  'providerAttempts',
  'timeline',
  'toolOperations',
  'transcript',
  'effects',
  'requestFacts',
  'undoReceipts',
];

export function createAgentDomainTransaction(
  previous: AgentSessionAggregate | null,
  next: AgentSessionAggregate,
): AgentDomainTransaction {
  assertAgentSessionTransition(previous, next);
  if (!previous) return { events: [{ type: 'session.created', session: cloneAgentSession(next) }] };

  const events: AgentDomainEvent[] = [];
  const patch: Partial<AgentSessionScalars> = {};
  const removedKeys: string[] = [];
  const scalarKeys = new Set([
    ...Object.keys(previous),
    ...Object.keys(next),
  ] as Array<keyof AgentSessionAggregate>);
  for (const key of scalarKeys) {
    if (COLLECTIONS.includes(key as AgentEntityCollection)) continue;
    if (!isDeepStrictEqual(previous[key], next[key])) {
      if (Object.hasOwn(next, key)) Object.assign(patch, { [key]: structuredClone(next[key]) });
      else removedKeys.push(key);
    }
  }
  if (Object.keys(patch).length > 0 || removedKeys.length > 0) {
    events.push({ type: 'session.updated', patch, removedKeys });
  }

  for (const collection of COLLECTIONS) {
    const before = entities(previous, collection);
    const after = entities(next, collection);
    const beforeById = new Map(before.map((entity) => [entityId(collection, entity), entity]));
    const afterIds = new Set(after.map((entity) => entityId(collection, entity)));
    for (const entity of before) {
      const id = entityId(collection, entity);
      if (!afterIds.has(id)) events.push({ type: 'entity.removed', collection, entityId: id });
    }
    for (const entity of after) {
      const id = entityId(collection, entity);
      if (!isDeepStrictEqual(beforeById.get(id), entity)) {
        events.push({ type: 'entity.upserted', collection, entity: structuredClone(entity) });
      }
    }
  }
  if (events.length === 0) throw new Error('Iris Agent commit did not contain a domain change.');
  return { events };
}

export function applyAgentDomainTransaction(
  previous: AgentSessionAggregate | null,
  transaction: AgentDomainTransaction,
): AgentSessionAggregate {
  let session = previous ? cloneAgentSession(previous) : null;
  for (const event of transaction.events) {
    if (event.type === 'session.created') {
      if (session) throw new Error('Iris Agent journal attempted to create an existing Session.');
      session = cloneAgentSession(event.session);
      continue;
    }
    if (!session) throw new Error('Iris Agent journal mutated a Session before creation.');
    if (event.type === 'session.updated') {
      Object.assign(session, structuredClone(event.patch));
      for (const key of event.removedKeys) delete (session as unknown as Record<string, unknown>)[key];
      continue;
    }
    const target = entities(session, event.collection);
    const index = target.findIndex((entity) => entityId(event.collection, entity) === (
      event.type === 'entity.removed' ? event.entityId : entityId(event.collection, event.entity)
    ));
    if (event.type === 'entity.removed') {
      if (index < 0) throw new Error('Iris Agent journal removed an unknown entity.');
      target.splice(index, 1);
      continue;
    }
    const entity = structuredClone(event.entity);
    if (index < 0) target.push(entity);
    else target[index] = entity;
  }
  if (!session) throw new Error('Iris Agent journal transaction did not create a Session.');
  assertAgentSessionTransition(previous, session);
  return session;
}

export function isAgentDomainTransaction(value: unknown): value is AgentDomainTransaction {
  return isRecord(value) && Array.isArray(value.events) && value.events.length > 0 && value.events.every((event) => {
    if (!isRecord(event) || typeof event.type !== 'string') return false;
    if (event.type === 'session.created') return isRecord(event.session);
    if (event.type === 'session.updated') {
      return isRecord(event.patch) && !Object.keys(event.patch).some((key) => isCollection(key)) &&
        Array.isArray(event.removedKeys) && event.removedKeys.every(
          (key) => typeof key === 'string' && !isCollection(key),
        );
    }
    if (event.type === 'entity.removed') {
      return isCollection(event.collection) && typeof event.entityId === 'string';
    }
    return event.type === 'entity.upserted' && isCollection(event.collection) && isRecord(event.entity);
  });
}

function assertAgentSessionTransition(
  previous: AgentSessionAggregate | null,
  next: AgentSessionAggregate,
): void {
  assertUnique(next.timeline.map((activity) => activity.id), 'Timeline Activity ID');
  assertUnique(next.timeline.map((activity) => String(activity.ordinal)), 'Timeline ordinal');
  for (let index = 0; index < next.timeline.length; index += 1) {
    if (next.timeline[index]!.ordinal <= (next.timeline[index - 1]?.ordinal ?? 0)) {
      throw new Error('Iris Agent Timeline ordinals must be strictly increasing.');
    }
  }
  assertAggregateReferences(next);
  if (!previous) return;
  if (next.id !== previous.id || next.projectRoot !== previous.projectRoot || next.kind !== previous.kind) {
    throw new Error('Iris Agent Session identity is immutable.');
  }
  if (next.revision !== previous.revision + 1) {
    throw new Error('Iris Agent Session revision must increase by exactly one.');
  }
  assertStableEntities(previous.timeline, next.timeline, 'Timeline Activity');
  assertStableOrder(previous.timeline, next.timeline, 'Timeline Activity');
  assertMonotonicStates(previous.turns, next.turns, turnTransitions, 'Turn');
  assertMonotonicStates(previous.providerCalls, next.providerCalls, providerTransitions, 'Provider Call');
  assertMonotonicStates(previous.providerAttempts, next.providerAttempts, providerTransitions, 'Provider Attempt');
  assertMonotonicStates(previous.toolOperations, next.toolOperations, operationTransitions, 'Tool operation');
  assertMonotonicStates(previous.timeline.filter(isReply), next.timeline.filter(isReply), replyTransitions, 'Reply');
  assertMonotonicStates(previous.timeline.filter(isTool), next.timeline.filter(isTool), toolTransitions, 'Tool Activity');
  assertAppendOnly(previous.transcript, next.transcript, 'Provider Transcript');
  assertAppendOnly(previous.effects, next.effects, 'Effect Ledger');
  assertAppendOnly(previous.requestFacts, next.requestFacts, 'Request facts');
  assertAppendOnly(previous.undoReceipts, next.undoReceipts, 'Undo receipts');
}

function assertAggregateReferences(session: AgentSessionAggregate): void {
  const turns = new Map(session.turns.map((turn) => [turn.id, turn]));
  const calls = new Map(session.providerCalls.map((call) => [call.id, call]));
  const attempts = new Map(session.providerAttempts.map((attempt) => [attempt.id, attempt]));
  const activities = new Map(session.timeline.map((activity) => [activity.id, activity]));
  assertUnique(session.turns.map((turn) => turn.id), 'Turn ID');
  assertUnique(session.providerCalls.map((call) => call.id), 'Provider Call ID');
  assertUnique(session.providerAttempts.map((attempt) => attempt.id), 'Provider Attempt ID');
  assertUnique(session.toolOperations.map((operation) => operation.id), 'tool operation ID');
  assertUnique(session.transcript.map((frame) => frame.id), 'Provider frame ID');
  assertUnique(session.effects.map((effect) => effect.id), 'Effect ID');
  const highestOrdinal = Math.max(0, ...session.timeline.map((activity) => activity.ordinal));
  if (session.nextOrdinal !== highestOrdinal + 1) {
    throw new Error('Iris Agent nextOrdinal must follow the canonical Timeline.');
  }
  if (session.currentTurnId && !turns.has(session.currentTurnId)) throw new Error('Current Turn is missing.');
  for (const turn of session.turns) {
    const user = activities.get(turn.userActivityId);
    if (user?.kind !== 'user' || user.turnId !== turn.id) throw new Error('Turn user Activity is invalid.');
  }
  for (const activity of session.timeline) {
    if (!turns.has(activity.turnId)) throw new Error('Timeline Activity Turn is missing.');
    if (activity.kind === 'reply') {
      const call = calls.get(activity.providerCallId);
      const attempt = attempts.get(activity.providerAttemptId);
      if (!call || call.turnId !== activity.turnId || !attempt || attempt.providerCallId !== call.id) {
        throw new Error('Timeline Activity Provider correlation is invalid.');
      }
    }
    if (activity.kind === 'tool') {
      const call = calls.get(activity.providerCallId);
      if (!call || call.turnId !== activity.turnId) {
        throw new Error('Tool Activity Provider Call correlation is invalid.');
      }
    }
  }
  for (const call of session.providerCalls) {
    if (!turns.has(call.turnId)) throw new Error('Provider Call Turn is invalid.');
    for (const attemptId of call.attemptIds) {
      if (attempts.get(attemptId)?.providerCallId !== call.id) throw new Error('Provider Attempt reference is invalid.');
    }
  }
  for (const attempt of session.providerAttempts) {
    const call = calls.get(attempt.providerCallId);
    if (!call || call.turnId !== attempt.turnId ||
      !call.attemptIds.includes(attempt.id)) {
      throw new Error('Provider Attempt Call correlation is invalid.');
    }
  }
  for (const frame of session.transcript) {
    if (frame.role === 'user') {
      if (!turns.has(frame.turnId)) throw new Error('Provider Transcript user input correlation is invalid.');
      continue;
    }
    if (frame.role === 'assistant') {
      const call = calls.get(frame.providerCallId);
      if (!call || call.turnId !== frame.turnId) {
        throw new Error('Provider Transcript Call correlation is invalid.');
      }
      continue;
    }
    const tool = session.timeline.find(
      (activity) => activity.kind === 'tool' && activity.toolCallId === frame.toolCallId,
    );
    if (!tool || tool.turnId !== frame.turnId) {
      throw new Error('Provider Transcript Tool correlation is invalid.');
    }
  }
  for (const operation of session.toolOperations) {
    const activity = activities.get(operation.toolActivityId);
    if (activity?.kind !== 'tool' || activity.turnId !== operation.turnId) {
      throw new Error('Tool operation Activity correlation is invalid.');
    }
  }
  for (const effect of session.effects) {
    const activity = activities.get(effect.toolActivityId);
    if (activity?.kind !== 'tool' || activity.turnId !== effect.turnId) {
      throw new Error('Effect Tool Activity correlation is invalid.');
    }
  }
}

function assertStableEntities(
  previous: AgentTimelineActivity[],
  next: AgentTimelineActivity[],
  label: string,
): void {
  const nextById = new Map(next.map((entity) => [entity.id, entity]));
  for (const entity of previous) {
    const candidate = nextById.get(entity.id);
    if (!candidate) throw new Error(`${label} cannot be deleted.`);
    if (candidate.kind !== entity.kind || candidate.ordinal !== entity.ordinal ||
      candidate.turnId !== entity.turnId) {
      throw new Error(`${label} identity and ordering fields are immutable.`);
    }
  }
}

function assertStableOrder<T extends { id: string }>(previous: T[], next: T[], label: string): void {
  const retained = next.filter((entity) => previous.some((candidate) => candidate.id === entity.id));
  if (!isDeepStrictEqual(retained.map((entity) => entity.id), previous.map((entity) => entity.id))) {
    throw new Error(`${label} cannot be reordered.`);
  }
}

function assertAppendOnly<T>(
  previous: T[],
  next: T[],
  label: string,
): void {
  if (next.length < previous.length) throw new Error(`${label} is append-only.`);
  for (let index = 0; index < previous.length; index += 1) {
    if (!isDeepStrictEqual(previous[index], next[index])) {
      throw new Error(`${label} entries are immutable and cannot be reordered.`);
    }
  }
}

function assertMonotonicStates<T extends { id: string; state: string }>(
  previous: T[],
  next: T[],
  transitions: Readonly<Record<string, readonly string[]>>,
  label: string,
): void {
  const nextById = new Map(next.map((entity) => [entity.id, entity]));
  for (const entity of previous) {
    const candidate = nextById.get(entity.id);
    if (!candidate) throw new Error(`${label} cannot be deleted.`);
    if (candidate.state === entity.state && transitions[entity.state]?.length === 0 &&
      !isDeepStrictEqual(candidate, entity)) {
      throw new Error(`${label} is immutable after reaching ${entity.state}.`);
    }
    if (candidate.state !== entity.state && !transitions[entity.state]?.includes(candidate.state)) {
      throw new Error(`${label} state cannot transition from ${entity.state} to ${candidate.state}.`);
    }
  }
}

const turnTransitions = {
  running: ['pausing', 'paused', 'fulfilled', 'abandoned', 'removed'],
  pausing: ['paused', 'fulfilled', 'abandoned', 'removed'],
  paused: ['running', 'fulfilled', 'abandoned', 'removed'],
  fulfilled: ['removed'],
  abandoned: ['removed'],
  removed: [],
} as const;
const providerTransitions = {
  running: ['completed', 'failed', 'aborted'],
  completed: [], failed: [], aborted: [],
} as const;
const operationTransitions = { running: ['completed', 'failed'], completed: [], failed: [] } as const;
const replyTransitions = {
  streaming: ['completed', 'stopped', 'failed'], completed: [], stopped: [], failed: [],
} as const;
const toolTransitions = {
  running: ['completed', 'failed', 'canceled'], completed: [], failed: [], canceled: [],
} as const;

function isReply(activity: AgentTimelineActivity): activity is Extract<AgentTimelineActivity, { kind: 'reply' }> {
  return activity.kind === 'reply';
}

function isTool(activity: AgentTimelineActivity): activity is Extract<AgentTimelineActivity, { kind: 'tool' }> {
  return activity.kind === 'tool';
}

function entities(session: AgentSessionAggregate, collection: AgentEntityCollection): AgentSessionEntity[] {
  return session[collection] as AgentSessionEntity[];
}

function entityId(collection: AgentEntityCollection, entity: AgentSessionEntity): string {
  if (collection === 'undoReceipts') return (entity as AgentUndoReceipt).commandId;
  return (entity as Exclude<AgentSessionEntity, AgentUndoReceipt>).id;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Iris Agent ${label} must be unique.`);
}

function isCollection(value: unknown): value is AgentEntityCollection {
  return typeof value === 'string' && COLLECTIONS.includes(value as AgentEntityCollection);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
