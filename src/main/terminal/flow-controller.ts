export type TerminalFlowBlocker = 'mirror' | 'renderer';

export class TerminalFlowController {
  private readonly blockers = new Set<TerminalFlowBlocker>();
  private paused = false;

  constructor(
    private readonly pause: () => void,
    private readonly resume: () => void,
  ) {}

  setBlocked(blocker: TerminalFlowBlocker, blocked: boolean): void {
    if (blocked) this.blockers.add(blocker);
    else this.blockers.delete(blocker);
    const shouldPause = this.blockers.size > 0;
    if (shouldPause === this.paused) return;
    this.paused = shouldPause;
    if (shouldPause) this.pause();
    else this.resume();
  }

  get snapshot(): { paused: boolean; blockers: TerminalFlowBlocker[] } {
    return { paused: this.paused, blockers: [...this.blockers] };
  }
}
