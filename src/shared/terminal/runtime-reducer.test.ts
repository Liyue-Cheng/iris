import { describe, expect, it } from 'vitest';
import { initialTerminalRuntimeState, reduceTerminalRuntime } from './runtime-reducer';

describe('terminal runtime reducer', () => {
  it('models attach, replay and reveal without side effects in the reducer', () => {
    let state = initialTerminalRuntimeState(7);
    let transition = reduceTerminalRuntime(state, { type: 'ATTACH' });
    expect(transition).toMatchObject({ accepted: true, effects: ['request-snapshot'] });
    state = transition.state;
    state = reduceTerminalRuntime(state, { type: 'SNAPSHOT_RECEIVED' }).state;
    transition = reduceTerminalRuntime(state, { type: 'REPLAY_DRAINED' });
    expect(transition).toEqual({
      state: { phase: 'live', epoch: 7 },
      effects: ['reveal'],
      accepted: true,
    });
  });

  it('rejects illegal transitions and makes dispose terminal', () => {
    const created = initialTerminalRuntimeState(1);
    expect(reduceTerminalRuntime(created, { type: 'REPLAY_DRAINED' }).accepted).toBe(false);
    const disposed = reduceTerminalRuntime(created, { type: 'DISPOSE' }).state;
    expect(reduceTerminalRuntime(disposed, { type: 'ATTACH' })).toEqual({
      state: disposed,
      effects: [],
      accepted: false,
    });
  });

  it('models history freeze and resync independently from PTY flow', () => {
    let state = { phase: 'live' as const, epoch: 2 };
    state = reduceTerminalRuntime(state, { type: 'USER_LEFT_BOTTOM' }).state as typeof state;
    const resync = reduceTerminalRuntime(state, { type: 'RESYNC' });
    expect(resync.state.phase).toBe('resyncing');
    expect(resync.effects).toEqual(['request-resync']);
    expect(reduceTerminalRuntime(resync.state, { type: 'RESYNC_DONE' }).state.phase).toBe('live');
  });
});
