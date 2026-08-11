export interface SequencedTerminalPayload {
  seq: number;
}

export interface ReplayOrderingState<T extends SequencedTerminalPayload> {
  holding: boolean;
  lastSeq: number;
  queue: T[];
}

export function createReplayOrdering<T extends SequencedTerminalPayload>(): ReplayOrderingState<T> {
  return { holding: true, lastSeq: -1, queue: [] };
}

export function acceptTerminalPayload<T extends SequencedTerminalPayload>(
  state: ReplayOrderingState<T>,
  payload: T,
): T | null {
  if (state.holding) {
    state.queue.push(payload);
    return null;
  }
  if (payload.seq <= state.lastSeq) return null;
  state.lastSeq = payload.seq;
  return payload;
}

export function releaseReplayQueue<T extends SequencedTerminalPayload>(
  state: ReplayOrderingState<T>,
  snapshotLastSeq: number,
): T[] {
  state.holding = false;
  state.lastSeq = snapshotLastSeq;
  const accepted: T[] = [];
  for (const payload of state.queue) {
    if (payload.seq <= state.lastSeq) continue;
    state.lastSeq = payload.seq;
    accepted.push(payload);
  }
  state.queue.length = 0;
  return accepted;
}
