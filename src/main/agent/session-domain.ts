import { randomUUID } from 'node:crypto';
import type { AgentCorrelation } from '@shared/agent-protocol';
import type { IrisAgentPauseReason } from '@shared/types';
import type { AgentSessionAggregate, AgentToolActivity } from './session-model';
import { cloneAgentSession, currentAgentTurn, isAgentSessionQuiescent } from './session-model';

export function assertIrisAgentExpectedRevision(
  session: AgentSessionAggregate,
  expectedRevision?: number,
): void {
  if (expectedRevision !== undefined && session.revision !== expectedRevision) {
    throw new Error('The Iris Agent session changed before this command was applied.');
  }
}

export function assertQuiescentIrisAgentSession(session: AgentSessionAggregate): void {
  if (!isAgentSessionQuiescent(session)) {
    throw new Error('Iris Agent session is still running.');
  }
}

export function assertUndoableLatestIrisAgentTurn(session: AgentSessionAggregate): void {
  const latest = [...session.turns].reverse().find((turn) => turn.state !== 'removed');
  if (!latest) throw new Error('There is no Iris Agent turn to undo.');
  if (!isAgentSessionQuiescent(session)) throw new Error('Iris Agent session is still running.');
}

export function undoLatestIrisAgentTurn(
  source: AgentSessionAggregate,
  commandId: string = randomUUID(),
  now = Date.now(),
): AgentSessionAggregate {
  assertUndoableLatestIrisAgentTurn(source);
  if (source.undoReceipts.some((receipt) => receipt.commandId === commandId)) return source;
  const session = cloneAgentSession(source);
  const turn = [...session.turns].reverse().find((candidate) => candidate.state !== 'removed')!;
  turn.state = 'removed';
  turn.closedAt ??= now;
  session.currentTurnId = null;
  session.state = 'idle';
  session.undoReceipts.push({
    commandId,
    removedTurnId: turn.id,
    removedAt: now,
    externalEffectsRetained: true,
  });
  return session;
}

export function matchesActiveAgentTurn(
  session: AgentSessionAggregate,
  correlation: AgentCorrelation,
): boolean {
  if (correlation.sessionId !== session.id) return false;
  if (correlation.workerEpoch !== undefined && correlation.workerEpoch !== session.workerEpoch) return false;
  if (!session.currentTurnId) return false;
  if (correlation.turnId !== undefined && correlation.turnId !== session.currentTurnId) return false;
  const turn = currentAgentTurn(session);
  return turn?.state === 'running' || turn?.state === 'pausing';
}

export function completeActiveAgentTurn(
  source: AgentSessionAggregate,
  correlation: AgentCorrelation,
  now = Date.now(),
): AgentSessionAggregate {
  if (!matchesActiveAgentTurn(source, correlation)) return source;
  const session = cloneAgentSession(source);
  const turn = currentAgentTurn(session)!;
  turn.state = 'fulfilled';
  turn.closedAt = now;
  delete turn.pauseReason;
  delete turn.error;
  completeStreamingReplies(session, turn.id, 'completed', 'committed', now);
  session.state = 'idle';
  session.currentTurnId = null;
  delete session.stopRequestedTurnId;
  return session;
}

export function pauseActiveAgentTurn(
  source: AgentSessionAggregate,
  correlation: AgentCorrelation,
  reason: IrisAgentPauseReason,
  message: string,
  now = Date.now(),
): AgentSessionAggregate {
  if (!matchesActiveAgentTurn(source, correlation)) return source;
  const completed = completeCommittedAssistantTurn(source, now);
  if (completed !== source) return completed;
  const session = cloneAgentSession(source);
  const turn = currentAgentTurn(session)!;
  const stopped = reason === 'user';
  turn.state = 'paused';
  turn.pauseReason = reason;
  turn.error = message;
  completeStreamingReplies(session, turn.id, stopped ? 'stopped' : 'failed', 'excluded', now, message);
  for (const activity of session.timeline) {
    if (activity.kind === 'tool' && activity.turnId === turn.id && activity.state === 'running') {
      activity.state = 'canceled';
      activity.completedAt = now;
      if (!session.transcript.some(
        (frame) => frame.role === 'tool' && frame.toolCallId === activity.toolCallId,
      )) {
        session.transcript.push({
          id: `interrupted-tool-result:${turn.id}:${activity.toolCallId}`,
          turnId: turn.id,
          role: 'tool',
          toolCallId: activity.toolCallId,
          content: message,
          providerMessage: {
            role: 'toolResult',
            toolCallId: activity.toolCallId,
            toolName: activity.tool,
            content: [{ type: 'text', text: message }],
            isError: true,
            timestamp: now,
          },
          createdAt: now,
        });
      }
    }
  }
  for (const operation of session.toolOperations) {
    if (operation.turnId === turn.id && operation.state === 'running') {
      operation.state = 'failed';
      operation.error = message;
      operation.completedAt = now;
    }
  }
  for (const call of session.providerCalls) {
    if (call.turnId === turn.id && call.state === 'running') {
      call.state = stopped ? 'aborted' : 'failed';
      call.completedAt = now;
      call.error = message;
    }
  }
  for (const attempt of session.providerAttempts) {
    if (attempt.turnId === turn.id && attempt.state === 'running') {
      attempt.state = stopped ? 'aborted' : 'failed';
      attempt.completedAt = now;
      attempt.error = message;
    }
  }
  appendInterruptedToolResults(session, turn.id, message, now);
  session.state = 'paused';
  session.currentTurnId = turn.id;
  delete session.stopRequestedTurnId;
  return session;
}

export function preparePausedAgentTurnForResume(
  source: AgentSessionAggregate,
  now = Date.now(),
): AgentSessionAggregate {
  const turn = currentAgentTurn(source);
  if (!turn || turn.state !== 'paused') return source;
  const completed = completeCommittedAssistantTurn(source, now);
  if (completed !== source) return completed;
  const session = cloneAgentSession(source);
  const changed = appendInterruptedToolResults(
    session,
    turn.id,
    turn.error ?? 'The Agent stopped before the tool result was committed.',
    now,
  );
  return changed ? session : source;
}

export function resumePausedAgentTurn(source: AgentSessionAggregate): AgentSessionAggregate {
  const session = cloneAgentSession(source);
  const turn = currentAgentTurn(session);
  if (!turn || turn.state !== 'paused') throw new Error('Only the latest paused Iris Agent turn can continue.');
  turn.state = 'running';
  delete turn.pauseReason;
  delete turn.error;
  session.state = 'running';
  return session;
}

export function abandonOpenAgentTurn(
  source: AgentSessionAggregate,
  now = Date.now(),
): AgentSessionAggregate {
  const session = cloneAgentSession(source);
  const turn = session.turns.find((candidate) => candidate.id === session.currentTurnId);
  if (turn && turn.state !== 'fulfilled' && turn.state !== 'abandoned' && turn.state !== 'removed') {
    turn.state = 'abandoned';
    turn.closedAt = now;
  }
  session.currentTurnId = null;
  session.state = 'idle';
  delete session.stopRequestedTurnId;
  return session;
}

function completeStreamingReplies(
  session: AgentSessionAggregate,
  turnId: string,
  state: 'completed' | 'stopped' | 'failed',
  disposition: 'committed' | 'excluded',
  now: number,
  error?: string,
): void {
  for (const activity of session.timeline) {
    if (activity.kind !== 'reply' || activity.turnId !== turnId || activity.state !== 'streaming') continue;
    activity.state = state;
    activity.contextDisposition = disposition;
    activity.completedAt = now;
    if (error && state === 'failed') activity.error = error;
  }
}

function completeCommittedAssistantTurn(
  source: AgentSessionAggregate,
  now: number,
): AgentSessionAggregate {
  const turn = currentAgentTurn(source);
  if (!turn) return source;
  const frame = [...source.transcript].reverse().find((candidate) => candidate.turnId === turn.id);
  if (!frame || frame.role !== 'assistant' || !isSuccessfulFinalAssistant(frame.providerMessage)) return source;
  const session = cloneAgentSession(source);
  const targetTurn = currentAgentTurn(session)!;
  targetTurn.state = 'fulfilled';
  targetTurn.closedAt = now;
  delete targetTurn.pauseReason;
  delete targetTurn.error;
  completeStreamingReplies(session, targetTurn.id, 'completed', 'committed', now);
  const call = session.providerCalls.find((candidate) => candidate.id === frame.providerCallId);
  if (call?.state === 'running') {
    call.state = 'completed';
    call.completedAt = now;
    delete call.error;
  }
  for (const attempt of session.providerAttempts) {
    if (attempt.providerCallId === frame.providerCallId && attempt.state === 'running') {
      attempt.state = 'completed';
      attempt.completedAt = now;
      delete attempt.error;
    }
  }
  session.state = 'idle';
  session.currentTurnId = null;
  delete session.stopRequestedTurnId;
  return session;
}

function appendInterruptedToolResults(
  session: AgentSessionAggregate,
  turnId: string,
  message: string,
  now: number,
): boolean {
  const turnFrames = session.transcript.filter((frame) => frame.turnId === turnId);
  let assistantIndex = -1;
  for (let index = turnFrames.length - 1; index >= 0; index -= 1) {
    if (turnFrames[index]?.role === 'assistant') {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return false;
  const assistant = turnFrames[assistantIndex]!;
  if (assistant.role !== 'assistant' || !Array.isArray(assistant.providerMessage?.content)) return false;
  const settledToolCallIds = new Set(
    turnFrames.slice(assistantIndex + 1).flatMap((frame) => frame.role === 'tool' ? [frame.toolCallId] : []),
  );
  let changed = false;
  for (const block of assistant.providerMessage.content) {
    if (!isRecord(block) || block.type !== 'toolCall' || typeof block.id !== 'string' ||
      !isAgentToolName(block.name) || settledToolCallIds.has(block.id)) continue;
    let activity = session.timeline.find(
      (candidate): candidate is AgentToolActivity => candidate.kind === 'tool' && candidate.toolCallId === block.id,
    );
    if (!activity) {
      activity = {
        kind: 'tool',
        id: block.id,
        ordinal: session.nextOrdinal++,
        turnId,
        providerCallId: assistant.providerCallId,
        toolCallId: block.id,
        tool: block.name,
        state: 'canceled',
        inputSummary: 'Interrupted before execution.',
        effectIds: [],
        createdAt: now,
        completedAt: now,
      };
      session.timeline.push(activity);
      changed = true;
    } else if (activity.state === 'running') {
      activity.state = 'canceled';
      activity.completedAt = now;
      changed = true;
    }
    const resultMessage = activity.state === 'completed'
      ? 'The tool completed, but its result was not committed before the Agent stopped. Re-check current state.'
      : activity.state === 'failed'
        ? activity.error ?? message
        : message;
    session.transcript.push({
      id: `interrupted-tool-result:${turnId}:${block.id}`,
      turnId,
      role: 'tool',
      toolCallId: block.id,
      content: resultMessage,
      providerMessage: {
        role: 'toolResult',
        toolCallId: block.id,
        toolName: block.name,
        content: [{ type: 'text', text: resultMessage }],
        isError: true,
        timestamp: now,
      },
      createdAt: now,
    });
    settledToolCallIds.add(block.id);
    changed = true;
  }
  return changed;
}

function isSuccessfulFinalAssistant(message: Record<string, unknown> | undefined): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  if (message.stopReason === 'error' || message.stopReason === 'aborted' || message.stopReason === 'toolUse') {
    return false;
  }
  return !message.content.some((block) => isRecord(block) && block.type === 'toolCall');
}

function isAgentToolName(value: unknown): value is AgentToolActivity['tool'] {
  return value === 'read' || value === 'edit' || value === 'write' || value === 'terminal';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
