export interface ViewportFitPort {
  fit(): void;
}

export class TerminalViewportController {
  private replaying = true;
  private deferred = false;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private observer: ResizeObserver | null = null;

  constructor(
    private readonly port: ViewportFitPort,
    private readonly debounceMs: number,
  ) {}

  get replayInProgress(): boolean {
    return this.replaying;
  }

  requestFit(allowDuringReplay = false): void {
    if (this.disposed) return;
    if (this.replaying && !allowDuringReplay) {
      this.deferred = true;
      return;
    }
    try {
      this.port.fit();
    } catch {
      // Layout can temporarily have zero dimensions.
    }
  }

  scheduleFit(): void {
    if (this.disposed) return;
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.requestFit();
    }, this.debounceMs);
  }

  observe(element: Element): void {
    if (this.disposed) return;
    this.observer?.disconnect();
    this.observer = new ResizeObserver(() => this.scheduleFit());
    this.observer.observe(element);
  }

  flushBeforeInput(): void {
    if (this.resizeTimer === null) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.requestFit();
  }

  applyDeferredDuringReplay(): boolean {
    if (!this.deferred) return false;
    this.deferred = false;
    this.requestFit(true);
    return true;
  }

  beginResync(): void {
    if (!this.disposed) this.replaying = true;
  }

  finishReplay(): void {
    if (this.disposed) return;
    this.replaying = false;
    if (this.deferred) {
      this.deferred = false;
      this.requestFit();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.observer?.disconnect();
    this.observer = null;
  }
}
