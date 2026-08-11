import type { ProjectScope, SessionOutputPayload } from '@shared/types';

export type OutputEmitter = (payload: SessionOutputPayload) => void;

export class TerminalOutputPump {
  private nextSequence = 0;
  private emittedSequence = -1;
  private pending: { chunks: Buffer[]; totalBytes: number; lastSeq: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deliveryEnabled: boolean;
  private readonly inFlight: Array<{ seq: number; bytes: number }> = [];
  private inFlightBytes = 0;
  private lastAcknowledgedSeq = -1;

  constructor(
    private readonly sessionId: string,
    private readonly scope: () => ProjectScope,
    private readonly emit: OutputEmitter,
    private readonly batchMs = 8,
    private readonly flow?: {
      highBytes: number;
      lowBytes: number;
      setBlocked(blocked: boolean): void;
    },
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
    this.emit({
      scope: this.scope(),
      sessionId: this.sessionId,
      data: bytes.toString('base64'),
      seq: lastSeq,
    });
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
