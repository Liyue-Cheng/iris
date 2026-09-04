import { isDeepStrictEqual } from 'node:util';
import type {
  AgentCompaction,
  AgentEffect,
  AgentIntent,
  AgentInvoke,
  AgentInvokeAttempt,
  AgentRequestFacts,
  AgentRewindReceipt,
  AgentSessionAggregate,
  AgentTimelineActivity,
  AgentToolOperation,
  AgentTurn,
} from './session-model';
import { cloneAgentSession, normalizeAgentSessionAggregate } from './session-model';

export type AgentEntityCollection =
  | 'intents'
  | 'turns'
  | 'invokes'
  | 'invokeAttempts'
  | 'timeline'
  | 'toolOperations'
  | 'effects'
  | 'requestFacts'
  | 'rewindReceipts'
  | 'compactions';

export type AgentSessionEntity =
  | AgentIntent
  | AgentTurn
  | AgentInvoke
  | AgentInvokeAttempt
  | AgentTimelineActivity
  | AgentToolOperation
  | AgentEffect
  | AgentRequestFacts
  | AgentRewindReceipt
  | AgentCompaction;

type AgentSessionScalars = Omit<AgentSessionAggregate, AgentEntityCollection>;

export type AgentDomainEvent =
  | { type: 'session.created'; session: AgentSessionAggregate }
  | { type: 'session.updated'; patch: Partial<AgentSessionScalars>; removedKeys: string[] }
  | { type: 'entity.upserted'; collection: AgentEntityCollection; entity: AgentSessionEntity };

export interface AgentDomainTransaction {
  events: AgentDomainEvent[];
}

const COLLECTIONS: AgentEntityCollection[] = [
  'intents',
  'turns',
  'invokes',
  'invokeAttempts',
  'timeline',
  'toolOperations',
  'effects',
  'requestFacts',
  'rewindReceipts',
  'compactions',
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
      session = normalizeAgentSessionAggregate(cloneAgentSession(event.session));
      continue;
    }
    if (!session) throw new Error('Iris Agent journal mutated a Session before creation.');
    if (event.type === 'session.updated') {
      Object.assign(session, structuredClone(event.patch));
      for (const key of event.removedKeys) delete (session as unknown as Record<string, unknown>)[key];
      continue;
    }
    const target = entities(session, event.collection);
    const eventId = entityId(event.collection, event.entity);
    const index = target.findIndex((entity) => entityId(event.collection, entity) === eventId);
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
    if (event.type === 'session.created') {
      return isRecord(event.session) && Array.isArray(event.session.activeIntentIds) &&
        Array.isArray(event.session.turns) && Array.isArray(event.session.invokeAttempts) &&
        !Object.hasOwn(event.session, 'transcript');
    }
    if (event.type === 'session.updated') {
      return isRecord(event.patch) && !Object.keys(event.patch).some((key) => isCollection(key)) &&
        Array.isArray(event.removedKeys) && event.removedKeys.every(
          (key) => typeof key === 'string' && !isCollection(key),
        );
    }
    return event.type === 'entity.upserted' && isCollection(event.collection) && isRecord(event.entity);
  });
}

function assertAgentSessionTransition(
  previous: AgentSessionAggregate | null,
  next: AgentSessionAggregate,
): void {
  assertAggregateReferences(next);
  if (!previous) return;
  if (next.id !== previous.id || next.projectRoot !== previous.projectRoot || next.kind !== previous.kind) {
    throw new Error('Iris Agent Session identity is immutable.');
  }
  if (next.revision !== previous.revision + 1) {
    throw new Error('Iris Agent Session revision must increase by exactly one.');
  }
  assertStableEntities(previous.timeline, next.timeline, 'Timeline Activity');
  assertAppendOrder(previous.intents, next.intents, 'Intent');
  assertAppendOrder(previous.turns, next.turns, 'Turn');
  assertAppendOrder(previous.invokes, next.invokes, 'Invoke');
  assertAppendOrder(previous.invokeAttempts, next.invokeAttempts, 'Invoke Attempt');
  assertAppendOrder(previous.timeline, next.timeline, 'Timeline Activity');
  assertAppendOrder(previous.toolOperations, next.toolOperations, 'Tool operation');
  assertMonotonicStates(previous.intents, next.intents, intentTransitions, 'Intent');
  assertMonotonicStates(previous.turns, next.turns, turnTransitions, 'Turn');
  assertMonotonicStates(previous.invokes, next.invokes, invokeTransitions, 'Invoke');
  assertMonotonicStates(previous.invokeAttempts, next.invokeAttempts, invokeTransitions, 'Invoke Attempt');
  assertMonotonicStates(previous.toolOperations, next.toolOperations, operationTransitions, 'Tool operation');
  assertMonotonicStates(previous.timeline.filter(isReply), next.timeline.filter(isReply), replyTransitions, 'Reply');
  assertMonotonicStates(previous.timeline.filter(isTool), next.timeline.filter(isTool), toolTransitions, 'Tool Activity');
  assertMonotonicStates(previous.compactions, next.compactions, compactionTransitions, 'Compaction');
  assertAppendOnly(previous.effects, next.effects, 'Effect Ledger');
  assertAppendOnly(previous.requestFacts, next.requestFacts, 'Request facts');
  assertAppendOnly(previous.rewindReceipts, next.rewindReceipts, 'Rewind receipts');
  assertAppendOrder(previous.compactions, next.compactions, 'Compaction');
}

function assertAggregateReferences(session: AgentSessionAggregate): void {
  const intents = new Map(session.intents.map((intent) => [intent.id, intent]));
  const turns = new Map(session.turns.map((turn) => [turn.id, turn]));
  const invokes = new Map(session.invokes.map((invoke) => [invoke.id, invoke]));
  const attempts = new Map(session.invokeAttempts.map((attempt) => [attempt.id, attempt]));
  const activities = new Map(session.timeline.map((activity) => [activity.id, activity]));

  assertUnique(session.intents.map((intent) => intent.id), 'Intent ID');
  assertUnique(session.turns.map((turn) => turn.id), 'Turn ID');
  assertUnique(session.invokes.map((invoke) => invoke.id), 'Invoke ID');
  assertUnique(session.invokeAttempts.map((attempt) => attempt.id), 'Invoke Attempt ID');
  assertUnique(session.timeline.map((activity) => activity.id), 'Timeline Activity ID');
  assertUnique(session.timeline.map((activity) => String(activity.ordinal)), 'Timeline ordinal');
  assertUnique(session.toolOperations.map((operation) => operation.id), 'tool operation ID');
  assertUnique(session.effects.map((effect) => effect.id), 'Effect ID');
  assertUnique(session.requestFacts.map((facts) => facts.id), 'Request facts ID');
  assertUnique(session.rewindReceipts.map((receipt) => receipt.commandId), 'Rewind command ID');
  assertUnique(session.activeIntentIds, 'active Intent path entry');

  for (let index = 0; index < session.timeline.length; index += 1) {
    if (session.timeline[index]!.ordinal <= (session.timeline[index - 1]?.ordinal ?? 0)) {
      throw new Error('Iris Agent Timeline ordinals must be strictly increasing.');
    }
  }
  const highestOrdinal = Math.max(0, ...session.timeline.map((activity) => activity.ordinal));
  if (session.nextOrdinal !== highestOrdinal + 1) {
    throw new Error('Iris Agent nextOrdinal must follow the canonical Timeline.');
  }
  for (const id of session.activeIntentIds) {
    const intent = intents.get(id);
    if (!intent || intent.state === 'superseded') throw new Error('Active Intent path is invalid.');
  }
  if (session.currentIntentId) {
    const current = intents.get(session.currentIntentId);
    if (!current || !session.activeIntentIds.includes(current.id) ||
      (current.state !== 'running' && current.state !== 'paused')) {
      throw new Error('Current Intent is invalid.');
    }
  }
  for (const intent of session.intents) {
    assertUnique(intent.turnIds, `Turn reference in Intent ${intent.id}`);
    for (const turnId of intent.turnIds) {
      if (turns.get(turnId)?.intentId !== intent.id) throw new Error('Intent Turn correlation is invalid.');
    }
  }
  for (const turn of session.turns) {
    const intent = intents.get(turn.intentId);
    const invoke = invokes.get(turn.invokeId);
    if (!intent?.turnIds.includes(turn.id)) throw new Error('Turn Intent correlation is invalid.');
    if (!invoke || invoke.turnId !== turn.id || invoke.intentId !== turn.intentId) {
      throw new Error('Turn Invoke correlation is invalid.');
    }
  }
  for (const invoke of session.invokes) {
    const turn = turns.get(invoke.turnId);
    if (!turn || turn.intentId !== invoke.intentId || turn.invokeId !== invoke.id) {
      throw new Error('Invoke Turn correlation is invalid.');
    }
    assertUnique(invoke.attemptIds, `Attempt reference in Invoke ${invoke.id}`);
    for (const attemptId of invoke.attemptIds) {
      if (attempts.get(attemptId)?.invokeId !== invoke.id) throw new Error('Invoke Attempt reference is invalid.');
    }
  }
  for (const attempt of session.invokeAttempts) {
    const invoke = invokes.get(attempt.invokeId);
    if (!invoke || invoke.intentId !== attempt.intentId || invoke.turnId !== attempt.turnId ||
      !invoke.attemptIds.includes(attempt.id)) {
      throw new Error('Invoke Attempt correlation is invalid.');
    }
  }
  for (const activity of session.timeline) {
    if (!intents.has(activity.intentId)) throw new Error('Timeline Activity Intent is missing.');
    const turn = turns.get(activity.turnId);
    const invoke = invokes.get(activity.invokeId);
    if (!turn || turn.intentId !== activity.intentId || !invoke || invoke.turnId !== turn.id) {
      throw new Error('Timeline Activity execution correlation is invalid.');
    }
    if (activity.kind === 'reply' && attempts.get(activity.invokeAttemptId)?.invokeId !== invoke.id) {
      throw new Error('Reply Invoke Attempt correlation is invalid.');
    }
  }
  for (const operation of session.toolOperations) {
    const activity = activities.get(operation.toolActivityId);
    if (activity?.kind !== 'tool' || activity.intentId !== operation.intentId ||
      activity.turnId !== operation.turnId) {
      throw new Error('Tool operation Activity correlation is invalid.');
    }
  }
  for (const effect of session.effects) {
    const activity = activities.get(effect.toolActivityId);
    if (activity?.kind !== 'tool' || activity.intentId !== effect.intentId || activity.turnId !== effect.turnId) {
      throw new Error('Effect Tool Activity correlation is invalid.');
    }
  }
  for (const facts of session.requestFacts) {
    if (!intents.has(facts.intentId)) throw new Error('Request facts Intent is missing.');
  }
  for (const receipt of session.rewindReceipts) {
    if (!intents.has(receipt.truncatedIntentId)) throw new Error('Rewind receipt Intent is missing.');
  }
  for (const compaction of session.compactions) {
    if (!intents.has(compaction.coveredThroughIntentId)) {
      throw new Error('Compaction covered-through Intent is missing.');
    }
    if (!intents.has(compaction.firstRetainedIntentId)) {
      throw new Error('Compaction first-retained Intent is missing.');
    }
  }
  if (session.activeCompactionId) {
    const active = session.compactions.find((compaction) => compaction.id === session.activeCompactionId);
    if (!active || active.state !== 'completed') throw new Error('Active compaction is invalid.');
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
      candidate.intentId !== entity.intentId) {
      throw new Error(`${label} identity and ordering fields are immutable.`);
    }
  }
}

function assertAppendOrder<T extends { id: string }>(previous: T[], next: T[], label: string): void {
  if (!isDeepStrictEqual(
    next.slice(0, previous.length).map((entity) => entity.id),
    previous.map((entity) => entity.id),
  )) {
    throw new Error(`${label} can only append new entities.`);
  }
}

function assertAppendOnly<T>(previous: T[], next: T[], label: string): void {
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
    if (candidate.state !== entity.state && !transitions[entity.state]?.includes(candidate.state)) {
      throw new Error(`${label} state cannot transition from ${entity.state} to ${candidate.state}.`);
    }
  }
}

const intentTransitions = {
  running: ['paused', 'completed', 'superseded'],
  paused: ['running', 'completed', 'superseded'],
  completed: ['superseded'],
  superseded: [],
} as const;
const turnTransitions = { running: ['settled'], settled: [] } as const;
const invokeTransitions = {
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
const compactionTransitions = {
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
  if (collection === 'rewindReceipts') return (entity as AgentRewindReceipt).commandId;
  return (entity as Exclude<AgentSessionEntity, AgentRewindReceipt>).id;
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
