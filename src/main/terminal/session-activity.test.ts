import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizedIdleThresholdMs,
  outputMarksSessionActive,
  SessionActivityController,
} from './session-activity';

afterEach(() => {
  vi.useRealTimers();
});

describe('session activity rules', () => {
  const windows = { startupGraceUntil: 100, resizeQuietUntil: 200, inputQuietUntil: 300 };

  it('keeps output quiet until every independent window has closed', () => {
    expect(outputMarksSessionActive(299, windows)).toBe(false);
    expect(outputMarksSessionActive(300, windows)).toBe(true);
  });

  it('enforces the existing minimum idle threshold', () => {
    expect(normalizedIdleThresholdMs(0)).toBe(100);
    expect(normalizedIdleThresholdMs(2)).toBe(2000);
  });

  it('owns quiet windows and the active-to-idle timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const changes: string[] = [];
    const activity = new SessionActivityController(0, () => 2_000, (state) => changes.push(state), {
      startupGraceMs: 1_500,
      resizeQuietMs: 500,
      inputQuietMs: 200,
    });
    activity.noteOutput(1_499);
    activity.noteOutput(1_500);
    expect(changes).toEqual(['active']);
    vi.advanceTimersByTime(2_000);
    expect(changes).toEqual(['active', 'idle']);
  });

  it('never emits a late idle transition after disposal', () => {
    vi.useFakeTimers();
    const changes: string[] = [];
    const activity = new SessionActivityController(0, () => 100, (state) => changes.push(state), {
      startupGraceMs: 0,
      resizeQuietMs: 500,
      inputQuietMs: 200,
    });
    activity.noteOutput(0);
    activity.dispose();
    vi.runAllTimers();
    expect(changes).toEqual(['active']);
  });
});
