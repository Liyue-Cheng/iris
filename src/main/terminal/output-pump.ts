import type { ProjectScope, SessionOutputPayload } from '@shared/types';

export type OutputEmitter = (payload: SessionOutputPayload) => void;

/** Flow-pressure report from the batcher to whoever can slow the producer. */
export interface OutputBatchFlow {
  highBytes: number;
  lowBytes: number;
  setBlocked(blocked: boolean): void;
}

/** Payload shape the batcher addresses; the sequence is passed to `build`. */
export type OutputPayloadBuilder<P> = (seq: number, data: string) => P;

/**
 * Coalesces raw output chunks into one payload per batch window and tracks
 * in-flight bytes so the producer can be paused while the consumer catches up.
 *
 * The sequence is a DELIVERY counter, not a byte offset: the batcher owns it,
 * so a snapshot-based replay can cut the stream at a boundary (`flush()` then
 * `replayBoundarySeq`) without any byte arithmetic, and a payload is dropped as
 * stale by a consumer that already received a snapshot covering it.
 *
 * The counter keeps advancing while delivery is disabled, which is what makes
 * "nobody is watching" cheap: chunks skip encode + IPC entirely, yet the mirror
 * snapshot a later client asks for is still authoritative and the sequences on
 * both sides of the attach gap stay ordered.
 */
export class TerminalOutputBatcher<P> {
  private nextSequence = 0;
  private emittedSequence = -1;
  private pending: { chunks: Buffer[]; totalBytes: number; lastSeq: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deliveryEnabled: boolean;
  private readonly inFlight: Array<{ seq: number; bytes: number }> = [];
  private inFlightBytes = 0;
  private lastAcknowledgedSeq = -1;

  constructor(
    private readonly build: OutputPayloadBuilder<P>,
    private readonly emit: (payload: P) => void,
    private readonly batchMs = 8,
    private readonly flow?: OutputBatchFlow,
    deliveryEnabled = true,
  ) {
    this.deliveryEnabled = deliveryEnabled;
  }

  get nextSeq(): number {
    return this.nextSequence;
  }

  get lastEmittedSeq(): number {
    return this.emittedSequence;
  }

  get replayBoundarySeq(): number {
    return this.nextSequence - 1;
  }

  get isDeliveryEnabled(): boolean {
    return this.deliveryEnabled;
  }

  enqueue(bytes: Buffer): number {
    const seq = this.nextSequence++;
    if (!this.deliveryEnabled) return seq;
    if (this.pending === null) {
      this.pending = { chunks: [bytes], totalBytes: bytes.length, lastSeq: seq };
    } else {
      this.pending.chunks.push(bytes);
      this.pending.totalBytes += bytes.length;
      this.pending.lastSeq = seq;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.batchMs);
    }
    return seq;
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    const { chunks, totalBytes, lastSeq } = this.pending;
    this.pending = null;
    const bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, totalBytes);
    this.emittedSequence = lastSeq;
    this.inFlight.push({ seq: lastSeq, bytes: bytes.length });
    this.inFlightBytes += bytes.length;
    if (this.flow && this.inFlightBytes >= this.flow.highBytes) this.flow.setBlocked(true);
    this.emit(this.build(lastSeq, bytes.toString('base64')));
  }

  acknowledge(seq: number): void {
    if (seq <= this.lastAcknowledgedSeq) return;
    this.lastAcknowledgedSeq = seq;
    while (this.inFlight[0] && this.inFlight[0].seq <= seq) {
      this.inFlightBytes -= this.inFlight.shift()!.bytes;
    }
    if (this.flow && this.inFlightBytes <= this.flow.lowBytes) this.flow.setBlocked(false);
  }

  setDeliveryEnabled(enabled: boolean): void {
    if (enabled === this.deliveryEnabled) return;
    this.deliveryEnabled = enabled;
    if (!enabled) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.pending = null;
      this.inFlight.length = 0;
      this.inFlightBytes = 0;
      this.flow?.setBlocked(false);
    }
  }

  get diagnostics(): {
    deliveryEnabled: boolean;
    pendingBytes: number;
    inFlightBytes: number;
    lastSeq: number;
    lastAcknowledgedSeq: number;
  } {
    return {
      deliveryEnabled: this.deliveryEnabled,
      pendingBytes: this.pending?.totalBytes ?? 0,
      inFlightBytes: this.inFlightBytes,
      lastSeq: this.nextSequence - 1,
      lastAcknowledgedSeq: this.lastAcknowledgedSeq,
    };
  }

  dispose(options: { flush: boolean }): void {
    if (options.flush) this.flush();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.inFlight.length = 0;
    this.inFlightBytes = 0;
    this.flow?.setBlocked(false);
  }
}

/** Project-terminal specialization: payloads carry the session and its scope. */
export class TerminalOutputPump extends TerminalOutputBatcher<SessionOutputPayload> {
  constructor(
    sessionId: string,
    scope: () => ProjectScope,
    emit: OutputEmitter,
    batchMs = 8,
    flow?: OutputBatchFlow,
    deliveryEnabled = true,
  ) {
    super(
      (seq, data) => ({ scope: scope(), sessionId, data, seq }),
      emit,
      batchMs,
      flow,
      deliveryEnabled,
    );
  }
}
