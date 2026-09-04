import type { AgentCorrelation } from '@shared/agent-protocol';
import { AppError } from '@shared/app-error';
import type { IrisAgentPauseReason } from '@shared/types';
import type { AgentSessionAggregate } from './session-model';
import { cloneAgentSession, currentAgentIntent, isAgentSessionQuiescent } from './session-model';

export function assertIrisAgentExpectedRevision(
  session: AgentSessionAggregate,
  expectedRevision?: number,
): void {
  if (expectedRevision !== undefined && session.revision !== expectedRevision) {
    throw new AppError(
      'session',
      'SessionRevisionConflict',
      'The Iris Agent session changed before this command was applied.',
      { retryable: true },
    );
  }
}

export function assertQuiescentIrisAgentSession(session: AgentSessionAggregate): void {
  if (!isAgentSessionQuiescent(session)) throw new Error('Iris Agent session is still running.');
}

export function assertIrisAgentCloseAllowed(
  session: AgentSessionAggregate,
  confirmBusy = false,
): void {
  if (isAgentSessionQuiescent(session) || confirmBusy) return;
  throw new AppError(
    'session',
    'SessionCloseConfirmationRequired',
    'The Iris Agent session is still working and requires explicit confirmation before closing.',
    { retryable: true },
  );
}

export function assertRewindableAgentIntent(session: AgentSessionAggregate): void {
  if (session.activeIntentIds.length === 0) throw new Error('There is no Iris Agent intent to rewind.');
  assertQuiescentIrisAgentSession(session);
}

export function truncateIntentChain(
  source: AgentSessionAggregate,
  commandId: string,
  now = Date.now(),
): AgentSessionAggregate {
  assertRewindableAgentIntent(source);
  if (source.rewindReceipts.some((receipt) => receipt.commandId === commandId)) return source;
  const session = cloneAgentSession(source);
  const intentId = session.activeIntentIds.pop()!;
  const intent = session.intents.find((candidate) => candidate.id === intentId);
  if (!intent) throw new Error('The active Iris Agent intent path is corrupt.');
  intent.state = 'superseded';
  intent.closedAt = now;
  delete intent.pauseReason;
  delete intent.pauseMessage;
  session.currentIntentId = null;
  session.state = 'idle';
  session.rewindReceipts.push({
    commandId,
    truncatedIntentId: intentId,
    revertedEffectIds: [],
    retainedEffectIds: [],
    createdAt: now,
  });
  return session;
}

export function matchesActiveAgentIntent(
  session: AgentSessionAggregate,
  correlation: AgentCorrelation,
): boolean {
  if (correlation.sessionId !== session.id) return false;
  if (correlation.workerEpoch !== undefined && correlation.workerEpoch !== session.workerEpoch) return false;
  if (!session.currentIntentId) return false;
  if (correlation.intentId !== undefined && correlation.intentId !== session.currentIntentId) return false;
  const intent = currentAgentIntent(session);
  return intent?.state === 'running';
}

export function completeActiveAgentIntent(
  source: AgentSessionAggregate,
  correlation: AgentCorrelation,
  now = Date.now(),
): AgentSessionAggregate {
  if (!matchesActiveAgentIntent(source, correlation)) return source;
  const session = cloneAgentSession(source);
  const intent = currentAgentIntent(session)!;
  intent.state = 'completed';
  intent.closedAt = now;
  delete intent.pauseReason;
  delete intent.pauseMessage;
  settleStreamingReplies(session, intent.id, 'completed', 'committed', now);
  settleLastTurn(session, intent.id, now);
  settleCommittedFinalInvoke(session, intent.id, now);
  session.state = 'idle';
  session.currentIntentId = null;
  delete session.stopRequestedIntentId;
  return session;
}

export function pauseActiveAgentIntent(
  source: AgentSessionAggregate,
  correlation: AgentCorrelation,
  reason: IrisAgentPauseReason,
  message: string,
  now = Date.now(),
): AgentSessionAggregate {
  if (!matchesActiveAgentIntent(source, correlation)) return source;
  if (hasCommittedFinalReply(source, source.currentIntentId!)) {
    return completeActiveAgentIntent(source, correlation, now);
  }
  const session = cloneAgentSession(source);
  const intent = currentAgentIntent(session)!;
  intent.state = 'paused';
  intent.pauseReason = reason;
  intent.pauseMessage = message;
  settleStreamingReplies(
    session,
    intent.id,
    reason === 'user' ? 'stopped' : 'failed',
    'excluded',
    now,
    message,
  );
  for (const activity of session.timeline) {
    if (activity.kind === 'tool' && activity.intentId === intent.id && activity.state === 'running') {
      activity.state = 'canceled';
      activity.completedAt = now;
    }
  }
  for (const operation of session.toolOperations) {
    if (operation.intentId === intent.id && operation.state === 'running') {
      operation.state = 'failed';
      operation.error = message;
      operation.completedAt = now;
    }
  }
  for (const invoke of session.invokes) {
    if (invoke.intentId === intent.id && invoke.state === 'running') {
      invoke.state = reason === 'user' ? 'aborted' : 'failed';
      invoke.completedAt = now;
      invoke.error = message;
    }
  }
  for (const attempt of session.invokeAttempts) {
    if (attempt.intentId === intent.id && attempt.state === 'running') {
      attempt.state = reason === 'user' ? 'aborted' : 'failed';
      attempt.completedAt = now;
      attempt.error = message;
    }
  }
  settleLastTurn(session, intent.id, now);
  session.state = 'paused';
  delete session.stopRequestedIntentId;
  return session;
}

export function resumePausedAgentIntent(source: AgentSessionAggregate): AgentSessionAggregate {
  const session = cloneAgentSession(source);
  const intent = currentAgentIntent(session);
  if (!intent || intent.state !== 'paused') {
    throw new Error('Only the latest paused Iris Agent intent can continue.');
  }
  intent.state = 'running';
  delete intent.pauseReason;
  delete intent.pauseMessage;
  session.state = 'running';
  return session;
}

export function supersedeOpenAgentIntent(
  source: AgentSessionAggregate,
  now = Date.now(),
): AgentSessionAggregate {
  const session = cloneAgentSession(source);
  const intent = currentAgentIntent(session);
  if (intent && intent.state !== 'completed' && intent.state !== 'superseded') {
    intent.state = 'superseded';
    intent.closedAt = now;
    session.activeIntentIds = session.activeIntentIds.filter((id) => id !== intent.id);
  }
  session.currentIntentId = null;
  session.state = 'idle';
  delete session.stopRequestedIntentId;
  return session;
}

function settleStreamingReplies(
  session: AgentSessionAggregate,
  intentId: string,
  state: 'completed' | 'stopped' | 'failed',
  disposition: 'committed' | 'excluded',
  now: number,
  error?: string,
): void {
  for (const activity of session.timeline) {
    if (activity.kind !== 'reply' || activity.intentId !== intentId || activity.state !== 'streaming') continue;
    activity.state = state;
    activity.contextDisposition = disposition;
    activity.completedAt = now;
    if (error && state === 'failed') activity.error = error;
  }
}

function settleLastTurn(session: AgentSessionAggregate, intentId: string, now: number): void {
  const turn = [...session.turns].reverse().find((candidate) => candidate.intentId === intentId);
  if (turn?.state === 'running') {
    turn.state = 'settled';
    turn.settledAt = now;
  }
}

function settleCommittedFinalInvoke(
  session: AgentSessionAggregate,
  intentId: string,
  now: number,
): void {
  const turn = [...session.turns].reverse().find((candidate) => candidate.intentId === intentId);
  if (!turn?.assistant || turn.assistant.toolCalls.length > 0) return;
  const invoke = session.invokes.find((candidate) => candidate.id === turn.invokeId);
  if (invoke?.state === 'running') {
    invoke.state = 'completed';
    invoke.completedAt = now;
    delete invoke.error;
  }
  for (const attempt of session.invokeAttempts) {
    if (attempt.invokeId === invoke?.id && attempt.state === 'running') {
      attempt.state = 'completed';
      attempt.completedAt = now;
      delete attempt.error;
    }
  }
}

function hasCommittedFinalReply(session: AgentSessionAggregate, intentId: string): boolean {
  const turn = [...session.turns].reverse().find((candidate) => candidate.intentId === intentId);
  return !!turn?.assistant && turn.assistant.toolCalls.length === 0;
}
