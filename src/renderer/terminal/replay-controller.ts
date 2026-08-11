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

export interface ReplayTerminalPort {
  readonly cols: number;
  readonly rows: number;
  write(data: Uint8Array, callback?: () => void): void;
  scrollToBottom(): void;
  beginSynchronizedReplay(): void;
  endSynchronizedReplay(callback?: () => void): void;
}

export class TerminalReplayController {
  private readonly ordering = createReplayOrdering<SessionOutputPayload>();
  private resyncPromise: Promise<void> | null = null;
  private synchronizedReplay = false;

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
    if (this.runtime.state.phase === 'history-frozen') {
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
      if (!this.runtime.isCurrent(epoch)) return;
      for (const payload of releaseReplayQueue(this.ordering, replay.lastSeq)) {
        this.terminal.write(base64ToBytes(payload.data), () => {
          void this.transport.acknowledge(payload.seq).catch(() => undefined);
        });
      }
      this.runtime.transition({ type: 'REPLAY_DRAINED' });
      this.finish(epoch, replay.lastSeq);
    } catch (error) {
      this.options.warn('[terminal] scrollback replay failed, going live', error);
      if (!this.runtime.isCurrent(epoch)) return;
      this.runtime.transition({ type: 'DEGRADE' });
      for (const payload of releaseReplayQueue(this.ordering, this.ordering.lastSeq)) {
        this.terminal.write(base64ToBytes(payload.data), () => {
          void this.transport.acknowledge(payload.seq).catch(() => undefined);
        });
      }
      this.finish(epoch, this.ordering.lastSeq);
    }
  }

  private async requestReplay(epoch: number): Promise<SessionReplaySnapshot> {
    const request = this.transport.requestReplay(this.terminal.cols, this.terminal.rows);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const removeOwner = this.runtime.own(() => {
      if (timer !== null) clearTimeout(timer);
    });
    try {
      return await Promise.race([
        request,
        new Promise<SessionReplaySnapshot>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`terminal replay timed out after ${this.options.timeoutMs}ms`)),
            this.options.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      removeOwner();
      if (!this.runtime.isCurrent(epoch)) void request.catch(() => undefined);
    }
  }

  private async resync(): Promise<void> {
    const epoch = this.runtime.capture();
    if (!this.runtime.transition({ type: 'RESYNC' })) return;
    this.viewport.beginResync();
    this.ordering.holding = true;
    this.ordering.queue.length = 0;
    try {
      const replay = await this.requestReplay(epoch);
      if (!this.runtime.isCurrent(epoch)) return;
      this.assertDimensions(replay);
      this.synchronizedReplay = true;
      this.terminal.beginSynchronizedReplay();
      await this.writeSnapshot(replay, epoch);
      if (!this.runtime.isCurrent(epoch)) return;
      for (const payload of releaseReplayQueue(this.ordering, replay.lastSeq)) {
        this.terminal.write(base64ToBytes(payload.data), () => {
          void this.transport.acknowledge(payload.seq).catch(() => undefined);
        });
      }
      this.runtime.transition({ type: 'RESYNC_DONE' });
      this.finish(epoch, replay.lastSeq);
    } catch (error) {
      this.options.warn('[terminal] history resync failed, returning to degraded live mode', error);
      if (!this.runtime.isCurrent(epoch)) return;
      this.runtime.transition({ type: 'DEGRADE' });
      for (const payload of releaseReplayQueue(this.ordering, this.ordering.lastSeq)) {
        this.terminal.write(base64ToBytes(payload.data), () => {
          void this.transport.acknowledge(payload.seq).catch(() => undefined);
        });
      }
      this.viewport.finishReplay();
      if (this.synchronizedReplay) {
        this.synchronizedReplay = false;
        this.terminal.endSynchronizedReplay();
      }
    }
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
