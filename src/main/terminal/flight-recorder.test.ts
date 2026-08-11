import { describe, expect, it } from 'vitest';
import { TerminalFlightRecorder } from './flight-recorder';

describe('TerminalFlightRecorder', () => {
  it('uses one injected monotonic clock and retains only a bounded anomaly window', () => {
    let now = 10;
    const recorder = new TerminalFlightRecorder(2, () => now);
    recorder.record('created');
    now += 25;
    recorder.record('paused', { bytes: 400_000 });
    now += 5;
    recorder.record('resumed');
    expect(recorder.snapshot()).toEqual([
      { atMs: 35, type: 'paused', details: { bytes: 400_000 } },
      { atMs: 40, type: 'resumed' },
    ]);
  });
});
