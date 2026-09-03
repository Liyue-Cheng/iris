import { describe, expect, it, vi } from 'vitest';
import { countBusySessions, type SessionLifecycleParticipant } from './session-lifecycle';

describe('session lifecycle', () => {
  it('aggregates busy state across independent session domains', async () => {
    const shutdown = vi.fn(async () => undefined);
    const participants: SessionLifecycleParticipant[] = [
      { name: 'terminal', busyCount: () => 2, shutdown },
      { name: 'agent', busyCount: () => 1, shutdown },
    ];
    expect(countBusySessions(participants)).toBe(3);
    await Promise.all(participants.map((participant) => participant.shutdown()));
    expect(shutdown).toHaveBeenCalledTimes(2);
  });
});
