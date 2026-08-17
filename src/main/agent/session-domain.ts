import type { IrisAgentSessionInfo } from '@shared/types';

export type IrisAgentTurnCorrelation = {
  sessionId: string;
  workerEpoch?: number;
  requestId?: string;
  turnId?: string;
};

export function isQuiescentIrisAgentSession(session: IrisAgentSessionInfo): boolean {
  return (
    (session.state === 'ready' || session.state === 'idle' || session.state === 'failed') &&
    session.activeTurnId === null
  );
}

export function assertQuiescentIrisAgentSession(session: IrisAgentSessionInfo): void {
  if (!isQuiescentIrisAgentSession(session)) {
    throw new Error('Stop the Iris Agent session before changing conversation history.');
  }
}

export function assertIrisAgentExpectedRevision(
  session: IrisAgentSessionInfo,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision === undefined) return;
  if (session.revision !== expectedRevision) {
    throw new Error(
      `Iris Agent session changed before the command was applied (expected revision ${expectedRevision}, current ${session.revision}).`,
    );
  }
}

export function assertUndoableLatestIrisAgentTurn(session: IrisAgentSessionInfo): void {
  const latestTurn = session.turns[session.turns.length - 1];
  if (!latestTurn) throw new Error('No Iris Agent turn is available to undo.');
  if (latestTurn.status === 'running') {
    throw new Error('The latest Iris Agent turn is still running.');
  }
  if (session.toolEvents.some((event) => event.turnId === latestTurn.id && event.state === 'running')) {
    throw new Error('The latest Iris Agent turn has an unsettled tool call.');
  }
}

export function undoLatestIrisAgentTurn(
  session: IrisAgentSessionInfo,
  commandId = 'legacy-undo',
): IrisAgentSessionInfo {
  assertUndoableLatestIrisAgentTurn(session);
  const removedTurnId = session.turns[session.turns.length - 1]!.id;
  const { stopRequestedTurnId: _stopRequestedTurnId, ...rest } = session;
  return {
    ...rest,
    activeTurnId: null,
    state: 'idle',
    lastError: '',
    messages: session.messages.filter((message) => message.turnId !== removedTurnId),
    turns: session.turns.slice(0, -1),
    toolEvents: session.toolEvents.filter((event) => event.turnId !== removedTurnId),
    // Effects are real-world audit facts and remain even when their source turn leaves the timeline.
    fileEffects: session.fileEffects,
    requestFacts: session.requestFacts.filter((facts) => facts.turnId !== removedTurnId),
    undoReceipts: [
      ...(session.undoReceipts ?? []),
      {
        commandId,
        removedTurnId,
        removedAt: Date.now(),
        resultingRevision: session.revision + 1,
        externalEffectsRetained: true,
      },
    ],
    pendingArtifactCleanupTurnIds: [
      ...new Set([...(session.pendingArtifactCleanupTurnIds ?? []), removedTurnId]),
    ],
  };
}

export function settleIrisAgentTurnDomain(
  session: IrisAgentSessionInfo,
  correlation: IrisAgentTurnCorrelation,
  requestedStatus: 'completed' | 'failed' | 'stopped',
  message?: string,
): IrisAgentSessionInfo {
  if (!matchesActiveTurn(session, correlation)) return session;
  const activeTurnId = session.activeTurnId!;
  const activeTurn = session.turns.find((turn) => turn.id === activeTurnId);
  if (!activeTurn || activeTurn.status !== 'running') return session;
  const status = session.stopRequestedTurnId === activeTurnId ? 'stopped' : requestedStatus;
  const error = status === 'completed'
    ? undefined
    : status === 'stopped'
      ? 'Stopped by user.'
      : (message ?? 'Iris Agent turn failed.');
  const { stopRequestedTurnId: _stopRequestedTurnId, ...rest } = session;
  return {
    ...rest,
    state: status === 'failed' ? 'failed' : 'idle',
    activeTurnId: null,
    lastError: error ?? '',
    turns: session.turns.map((turn) => turn.id === activeTurnId
      ? {
          ...turn,
          status,
          completedAt: Date.now(),
          ...(error ? { error } : {}),
        }
      : turn),
  };
}

export function matchesActiveIrisAgentTurn(
  session: IrisAgentSessionInfo,
  correlation: IrisAgentTurnCorrelation,
): boolean {
  return matchesActiveTurn(session, correlation);
}

function matchesActiveTurn(
  session: IrisAgentSessionInfo,
  correlation: IrisAgentTurnCorrelation,
): boolean {
  if (correlation.sessionId !== session.id || !session.activeTurnId) return false;
  if (correlation.workerEpoch !== undefined && correlation.workerEpoch !== session.workerEpoch) return false;
  const turn = session.turns.find((candidate) => candidate.id === session.activeTurnId);
  return !!turn && correlation.turnId === turn.id && correlation.requestId === turn.requestId;
}
