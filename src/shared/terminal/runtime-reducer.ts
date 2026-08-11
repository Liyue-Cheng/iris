export type TerminalRuntimePhase =
  | 'created'
  | 'attaching'
  | 'replaying'
  | 'live'
  | 'history-frozen'
  | 'resyncing'
  | 'degraded'
  | 'disposed';

export interface TerminalRuntimeState {
  phase: TerminalRuntimePhase;
  epoch: number;
}

export type TerminalRuntimeEvent =
  | { type: 'ATTACH' }
  | { type: 'SNAPSHOT_RECEIVED' }
  | { type: 'REPLAY_DRAINED' }
  | { type: 'USER_LEFT_BOTTOM' }
  | { type: 'RESYNC' }
  | { type: 'RESYNC_DONE' }
  | { type: 'DEGRADE' }
  | { type: 'DISPOSE' };

export type TerminalRuntimeEffect = 'request-snapshot' | 'reveal' | 'request-resync' | 'dispose';

export interface TerminalRuntimeTransition {
  state: TerminalRuntimeState;
  effects: readonly TerminalRuntimeEffect[];
  accepted: boolean;
}

export function initialTerminalRuntimeState(epoch: number): TerminalRuntimeState {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('runtime epoch must be non-negative');
  return { phase: 'created', epoch };
}

export function reduceTerminalRuntime(
  state: TerminalRuntimeState,
  event: TerminalRuntimeEvent,
): TerminalRuntimeTransition {
  if (state.phase === 'disposed') {
    return { state, effects: [], accepted: false };
  }
  if (event.type === 'DISPOSE') {
    return { state: { ...state, phase: 'disposed' }, effects: ['dispose'], accepted: true };
  }
  if (event.type === 'DEGRADE') {
    return { state: { ...state, phase: 'degraded' }, effects: [], accepted: true };
  }

  const next = (phase: TerminalRuntimePhase, effects: readonly TerminalRuntimeEffect[] = []) => ({
    state: { ...state, phase },
    effects,
    accepted: true,
  });

  switch (state.phase) {
    case 'created':
      return event.type === 'ATTACH' ? next('attaching', ['request-snapshot']) : rejected(state);
    case 'attaching':
      return event.type === 'SNAPSHOT_RECEIVED' ? next('replaying') : rejected(state);
    case 'replaying':
      return event.type === 'REPLAY_DRAINED' ? next('live', ['reveal']) : rejected(state);
    case 'live':
      return event.type === 'USER_LEFT_BOTTOM' ? next('history-frozen') : rejected(state);
    case 'history-frozen':
      return event.type === 'RESYNC' ? next('resyncing', ['request-resync']) : rejected(state);
    case 'resyncing':
      return event.type === 'RESYNC_DONE' ? next('live', ['reveal']) : rejected(state);
    case 'degraded':
      return event.type === 'RESYNC' ? next('resyncing', ['request-resync']) : rejected(state);
  }
}

function rejected(state: TerminalRuntimeState): TerminalRuntimeTransition {
  return { state, effects: [], accepted: false };
}
