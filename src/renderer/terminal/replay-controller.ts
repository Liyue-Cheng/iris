import type { SessionOutputPayload, SessionReplaySnapshot } from '@shared/types';
import {
  acceptTerminalPayload,
  createReplayOrdering,
  releaseReplayQueue,
} from '@shared/terminal/replay-ordering';
import { base64ToBytes } from './terminal-codec';
import { TerminalSessionRuntime } from './terminal-runtime';
import type { TerminalTransport } from './terminal-transport';
import type { TerminalViewportController } from './viewport-controller';
import type { XtermSnapshotState } from '@shared/terminal/xterm-snapshot-state';

export interface ReplayTerminalPort {
  readonly cols: number;
  readonly rows: number;
  write(data: Uint8Array | string, callback?: () => void): void;
  scrollToBottom(): void;
  beginSynchronizedReplay(): void;
  endSynchronizedReplay(callback?: () => void): void;
  restoreState?(state: XtermSnapshotState): void;
}

export class TerminalReplayController {
  private readonly ordering = createReplayOrdering<SessionOutputPayload>();
  private resyncPromise: Promise<void> | null = null;
  private synchronizedReplay = false;
  private needsSnapshot = false;

  constructor(
    private readonly runtime: TerminalSessionRuntime,
    private readonly transport: TerminalTransport,
    private readonly terminal: ReplayTerminalPort,
    private readonly viewport: TerminalViewportController,
    private readonly options: {
      chunkBytes: number;
      timeoutMs: number;
      reveal: () => void;
      warn: (message: string, error?: unknown) => void;
    },
  ) {}

  onOutput(payload: SessionOutputPayload): void {
    if (!this.runtime.isCurrent(this.runtime.epoch)) return;
    if (
      this.runtime.state.phase === 'history-frozen' ||
      (this.needsSnapshot && this.runtime.state.phase === 'degraded')
    ) {
      void this.transport.acknowledge(payload.seq).catch(() => undefined);
      return;
    }
    const accepted = acceptTerminalPayload(this.ordering, payload);
    if (accepted) {
      this.terminal.write(base64ToBytes(accepted.data), () => {
        void this.transport.acknowledge(accepted.seq).catch(() => undefined);
      });
    }
  }

  freezeHistory(): void {
    if (this.runtime.state.phase === 'live') {
      this.runtime.transition({ type: 'USER_LEFT_BOTTOM' });
    }
  }

  resumeFromHistory(): Promise<void> {
    if (this.runtime.state.phase !== 'history-frozen' && this.runtime.state.phase !== 'degraded') {
      return Promise.resolve();
    }
    if (this.resyncPromise) return this.resyncPromise;
    // async-boundary: handled - the shared promise is returned to every caller.
    this.resyncPromise = this.resync().finally(() => {
      this.resyncPromise = null;
    });
    return this.resyncPromise;
  }

  async start(): Promise<void> {
    const epoch = this.runtime.capture();
    this.viewport.requestFit(true);
    try {
      await this.transport.attach();
      if (!this.runtime.isCurrent(epoch)) {
        await this.transport.detach();
        return;
      }
      let replay = await this.requestReplay(epoch);
      if (!this.runtime.isCurrent(epoch)) return;
      this.runtime.transition({ type: 'SNAPSHOT_RECEIVED' });

      if (this.viewport.applyDeferredDuringReplay()) {
        if (this.terminal.cols !== replay.cols || this.terminal.rows !== replay.rows) {
          replay = await this.requestReplay(epoch);
          if (!this.runtime.isCurrent(epoch)) return;
        }
      }
      this.assertDimensions(replay);
      await this.writeSnapshot(replay, epoch);
      await this.restoreContinuation(replay, epoch);
      if (!this.runtime.isCurrent(epoch)) return;
      this.needsSnapshot = false;
      for (const payload of releaseReplayQueue(this.ordering, replay.lastSeq)) {
        this.terminal.write(base64ToBytes(payload.data), () => {
          void this.transport.acknowledge(payload.seq).catch(() => undefined);
        });
      }
      this.runtime.transition({ type: 'REPLAY_DRAINED' });
      this.finish(epoch, replay.lastSeq);
    } catch (error) {
      this.options.warn('[terminal] scrollback replay failed; waiting for a fresh snapshot', error);
      if (!this.runtime.isCurrent(epoch)) return;
      this.holdForFreshSnapshot(epoch);
    }
  }

  private async requestReplay(epoch: number): Promise<SessionReplaySnapshot> {
    const request = this.transport.requestReplay(this.terminal.cols, this.terminal.rows);
    return new Promise((resolve, reject) => {
      let done = false;
      let release = (): void => undefined;
      const finish = (error: unknown, snapshot?: SessionReplaySnapshot): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        release();
        if (snapshot === undefined) reject(error);
        else resolve(snapshot);
      };
      const timer = setTimeout(
        () => finish(new Error(`terminal replay timed out after ${this.options.timeoutMs}ms`)),
        this.options.timeoutMs,
      );
      release = this.runtime.own(() => finish(new Error('terminal view disposed during replay')));
      // Observe both outcomes even if disposal or timeout has already won.
      // async-boundary: handled - both outcomes settle the owned outer promise.
      void request.then((snapshot) => {
        if (!this.runtime.isCurrent(epoch)) finish(new Error('terminal view disposed during replay'));
        else finish(undefined, snapshot);
      }, (error: unknown) => finish(error));
    });
  }

  private async resync(): Promise<void> {
    const epoch = this.runtime.capture();
    if (!this.runtime.transition({ type: 'RESYNC' })) return;
    this.viewport.beginResync();
    this.ordering.holding = true;
    this.ordering.queue.length = 0;
    try {
      await this.transport.attach();
      if (!this.runtime.isCurrent(epoch)) {
        await this.transport.detach();
        return;
      }
      const replay = await this.requestReplay(epoch);
      if (!this.runtime.isCurrent(epoch)) return;
      this.assertDimensions(replay);
      this.synchronizedReplay = true;
      this.terminal.beginSynchronizedReplay();
      await this.writeSnapshot(replay, epoch);
      await this.restoreContinuation(replay, epoch);
      if (!this.runtime.isCurrent(epoch)) return;
      this.needsSnapshot = false;
      for (const payload of releaseReplayQueue(this.ordering, replay.lastSeq)) {
        this.terminal.write(base64ToBytes(payload.data), () => {
          void this.transport.acknowledge(payload.seq).catch(() => undefined);
        });
      }
      this.runtime.transition({ type: 'RESYNC_DONE' });
      this.finish(epoch, replay.lastSeq);
    } catch (error) {
      this.options.warn('[terminal] history resync failed; waiting for a fresh snapshot', error);
      if (!this.runtime.isCurrent(epoch)) return;
      this.holdForFreshSnapshot(epoch);
    }
  }

  /** A partially restored screen is never a valid baseline for live bytes. */
  private holdForFreshSnapshot(epoch: number): void {
    this.runtime.transition({ type: 'DEGRADE' });
    this.needsSnapshot = true;
    let discardedSeq = this.ordering.lastSeq;
    for (const payload of this.ordering.queue) discardedSeq = Math.max(discardedSeq, payload.seq);
    this.ordering.queue.length = 0;
    this.ordering.holding = true;
    if (discardedSeq >= 0) {
      // The authoritative mirror retains these bytes; free the abandoned
      // renderer backlog while waiting for a complete replacement snapshot.
      void this.transport.acknowledge(discardedSeq).catch(() => undefined);
    }
    this.viewport.finishReplay();
    if (this.synchronizedReplay) {
      this.synchronizedReplay = false;
      this.terminal.endSynchronizedReplay();
    }
    requestAnimationFrame(() => {
      if (this.runtime.isCurrent(epoch) && this.runtime.state.phase === 'degraded') this.options.reveal();
    });
  }

  private assertDimensions(replay: SessionReplaySnapshot): void {
    if (this.terminal.cols !== replay.cols || this.terminal.rows !== replay.rows) {
      throw new Error(
        `terminal replay size mismatch renderer=${this.terminal.cols}x${this.terminal.rows} ` +
          `snapshot=${replay.cols}x${replay.rows}`,
      );
    }
  }

  private async writeSnapshot(replay: SessionReplaySnapshot, epoch: number): Promise<void> {
    if (!replay.data) return;
    const bytes = base64ToBytes(replay.data);
    for (let index = 0; index < bytes.length; index += this.options.chunkBytes) {
      if (!this.runtime.isCurrent(epoch)) return;
      this.terminal.write(bytes.subarray(index, index + this.options.chunkBytes));
      if (bytes.length > this.options.chunkBytes && index + this.options.chunkBytes < bytes.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  /** Host replay controls must finish before restoring parser continuation. */
  private async restoreContinuation(replay: SessionReplaySnapshot, epoch: number): Promise<void> {
    if (!this.runtime.isCurrent(epoch)) return;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        release();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error('terminal snapshot parse timed out')), this.options.timeoutMs);
      const release = this.runtime.own(() => finish(new Error('terminal view disposed during replay')));
      const restored = (): void => {
        if (done) return;
        if (!this.runtime.isCurrent(epoch)) { finish(); return; }
        try {
          if (replay.continuationState) {
            if (!this.terminal.restoreState) throw new Error('Terminal cannot restore snapshot continuation state');
            this.terminal.restoreState(replay.continuationState);
          }
          if (replay.parserTail) this.terminal.write(replay.parserTail);
          finish();
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      };
      if (this.synchronizedReplay) {
        this.synchronizedReplay = false;
        this.terminal.endSynchronizedReplay(restored);
      } else {
        this.terminal.write(new Uint8Array(0), restored);
      }
    });
  }

  private finish(epoch: number, acknowledgedSeq: number): void {
    let revealed = false;
    let bottomAnchored = false;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    const removeOwner = this.runtime.own(() => {
      if (fallback !== null) clearTimeout(fallback);
    });
    const reveal = (): void => {
      if (revealed || !this.runtime.isCurrent(epoch)) return;
      revealed = true;
      if (fallback !== null) clearTimeout(fallback);
      removeOwner();
      this.viewport.finishReplay();
      if (!bottomAnchored) this.terminal.scrollToBottom();
      if (acknowledgedSeq >= 0) {
        void this.transport.acknowledge(acknowledgedSeq).catch(() => undefined);
      }
      requestAnimationFrame(() => {
        if (this.runtime.isCurrent(epoch)) this.options.reveal();
      });
    };
    fallback = setTimeout(() => {
      this.options.warn('[terminal] replay fence timed out; revealing fallback');
      if (this.synchronizedReplay) {
        this.synchronizedReplay = false;
        this.terminal.endSynchronizedReplay();
      }
      reveal();
    }, this.options.timeoutMs);
    if (this.synchronizedReplay) {
      // Fence while DEC 2026 is still active, anchor the final buffer, then
      // disable synchronized output. DOM scroll and canvas rows commit together.
      this.terminal.write(new Uint8Array(0), () => {
        if (revealed || !this.runtime.isCurrent(epoch)) return;
        this.terminal.scrollToBottom();
        bottomAnchored = true;
        this.synchronizedReplay = false;
        this.terminal.endSynchronizedReplay(reveal);
      });
    } else {
      this.terminal.write(new Uint8Array(0), reveal);
    }
  }
}
