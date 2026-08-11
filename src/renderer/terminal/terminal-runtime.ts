import type { ProjectScope } from '@shared/types';
import {
  initialTerminalRuntimeState,
  reduceTerminalRuntime,
  type TerminalRuntimeEvent,
  type TerminalRuntimeState,
} from '@shared/terminal/runtime-reducer';

let nextEpoch = 1;

export class TerminalSessionRuntime {
  readonly epoch = nextEpoch++;
  private stateValue: TerminalRuntimeState = initialTerminalRuntimeState(this.epoch);
  private readonly disposables = new Set<() => void>();

  constructor(
    readonly sessionId: string,
    readonly scope: ProjectScope,
  ) {}

  get state(): TerminalRuntimeState {
    return this.stateValue;
  }

  transition(event: TerminalRuntimeEvent): boolean {
    const transition = reduceTerminalRuntime(this.stateValue, event);
    this.stateValue = transition.state;
    return transition.accepted;
  }

  capture(): number {
    return this.epoch;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.epoch && this.stateValue.phase !== 'disposed';
  }

  own(dispose: () => void): () => void {
    if (this.stateValue.phase === 'disposed') {
      dispose();
      return () => undefined;
    }
    this.disposables.add(dispose);
    return () => this.disposables.delete(dispose);
  }

  dispose(): void {
    if (!this.transition({ type: 'DISPOSE' })) return;
    for (const dispose of [...this.disposables].reverse()) {
      try {
        dispose();
      } catch {
        // Disposal is best effort; all remaining owners still need release.
      }
    }
    this.disposables.clear();
  }
}
