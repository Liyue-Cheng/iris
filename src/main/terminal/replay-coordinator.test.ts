import { describe, expect, it } from 'vitest';
import { ReplayCoordinator } from './replay-coordinator';

describe('ReplayCoordinator', () => {
  it('serializes replay for one session without blocking another session', async () => {
    const coordinator = new ReplayCoordinator();
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = coordinator.run('a', async () => {
      order.push('a1:start');
      await gate;
      order.push('a1:end');
    });
    const second = coordinator.run('a', async () => {
      order.push('a2');
    });
    const other = coordinator.run('b', async () => {
      order.push('b');
    });
    await other;
    expect(order).toEqual(['a1:start', 'b']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['a1:start', 'b', 'a1:end', 'a2']);
  });
});
