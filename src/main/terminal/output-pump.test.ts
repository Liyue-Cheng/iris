import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionOutputPayload } from '@shared/types';
import { TerminalOutputBatcher, TerminalOutputPump } from './output-pump';

afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalOutputPump', () => {
  it('concatenates a high chunk-count batch once and advances its replay boundary atomically', () => {
    vi.useFakeTimers();
    const emitted: SessionOutputPayload[] = [];
    const pump = new TerminalOutputPump(
      'session-1',
      () => ({ root: 'C:\\work', generation: 1 }),
      (payload) => emitted.push(payload),
    );
    const concatSpy = vi.spyOn(Buffer, 'concat');

    for (let index = 0; index < 10_000; index += 1) pump.enqueue(Buffer.from('x'));
    expect(pump.lastEmittedSeq).toBe(-1);
    expect(concatSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8);

    expect(concatSpy).toHaveBeenCalledOnce();
    expect(Buffer.from(emitted[0]!.data, 'base64').toString()).toBe('x'.repeat(10_000));
    expect(pump.lastEmittedSeq).toBe(9_999);
  });

  it('flushes pending output before lifecycle events and cancels its timer', () => {
    vi.useFakeTimers();
    const emitted: SessionOutputPayload[] = [];
    const pump = new TerminalOutputPump(
      'session-1',
      () => ({ root: 'C:\\work', generation: 1 }),
      (payload) => emitted.push(payload),
    );
    pump.enqueue(Buffer.from('last'));
    pump.dispose({ flush: true });
    vi.runAllTimers();
    expect(emitted).toHaveLength(1);
  });

  it('pauses at the high watermark and resumes only after ACK reaches the low watermark', () => {
    const blocked: boolean[] = [];
    const pump = new TerminalOutputPump(
      'session-1',
      () => ({ root: 'C:\\work', generation: 1 }),
      () => undefined,
      8,
      { highBytes: 4, lowBytes: 1, setBlocked: (value) => blocked.push(value) },
    );
    pump.enqueue(Buffer.from('four'));
    pump.flush();
    expect(blocked).toEqual([true]);
    expect(pump.diagnostics.inFlightBytes).toBe(4);
    pump.acknowledge(0);
    expect(blocked).toEqual([true, false]);
    expect(pump.diagnostics.inFlightBytes).toBe(0);
  });

  it('does not encode or emit hidden-session output but keeps the replay sequence advancing', () => {
    const emit = vi.fn();
    const pump = new TerminalOutputPump(
      'session-1',
      () => ({ root: 'C:\\work', generation: 1 }),
      emit,
      8,
      undefined,
      false,
    );
    pump.enqueue(Buffer.from('hidden'));
    pump.flush();
    expect(emit).not.toHaveBeenCalled();
    expect(pump.lastEmittedSeq).toBe(-1);
    expect(pump.replayBoundarySeq).toBe(0);
  });

  it('batches a custom payload shape and freezes its boundary for a snapshot replay', () => {
    vi.useFakeTimers();
    const emitted: Array<{ cursor: number; data: string }> = [];
    const pump = new TerminalOutputBatcher(
      (seq, data) => ({ cursor: seq, data }),
      (payload) => emitted.push(payload),
    );
    pump.enqueue(Buffer.from('a'));
    pump.enqueue(Buffer.from('b'));
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(8);

    // One payload carries both chunks and the sequence of the last one, which is
    // exactly the boundary a renderer dedupes a snapshot against.
    expect(emitted).toEqual([{ cursor: 1, data: Buffer.from('ab').toString('base64') }]);
    expect(pump.replayBoundarySeq).toBe(1);

    // Output produced after the boundary stays above it, so it is delivered live.
    pump.enqueue(Buffer.from('c'));
    pump.flush();
    expect(emitted.at(-1)).toEqual({ cursor: 2, data: Buffer.from('c').toString('base64') });
  });
});
