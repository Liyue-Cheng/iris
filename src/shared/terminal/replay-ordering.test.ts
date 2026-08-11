import { describe, expect, it } from 'vitest';
import { acceptTerminalPayload, createReplayOrdering, releaseReplayQueue } from './replay-ordering';

describe('terminal replay ordering', () => {
  it('subscribes first, removes snapshot overlap, and preserves arrival order', () => {
    const state = createReplayOrdering<{ seq: number; data: string }>();
    expect(acceptTerminalPayload(state, { seq: 4, data: 'inside snapshot' })).toBeNull();
    expect(acceptTerminalPayload(state, { seq: 5, data: 'first live' })).toBeNull();
    expect(acceptTerminalPayload(state, { seq: 6, data: 'second live' })).toBeNull();
    expect(releaseReplayQueue(state, 4).map((item) => item.data)).toEqual([
      'first live',
      'second live',
    ]);
  });

  it('drops duplicates and stale out-of-order payloads after replay', () => {
    const state = createReplayOrdering<{ seq: number }>();
    releaseReplayQueue(state, 10);
    expect(acceptTerminalPayload(state, { seq: 11 })).toEqual({ seq: 11 });
    expect(acceptTerminalPayload(state, { seq: 11 })).toBeNull();
    expect(acceptTerminalPayload(state, { seq: 9 })).toBeNull();
    expect(acceptTerminalPayload(state, { seq: 12 })).toEqual({ seq: 12 });
  });
});
