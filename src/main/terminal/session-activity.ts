export interface ActivityQuietWindows {
  startupGraceUntil: number;
  resizeQuietUntil: number;
  inputQuietUntil: number;
}

export function outputMarksSessionActive(now: number, windows: ActivityQuietWindows): boolean {
  return (
    now >= windows.startupGraceUntil &&
    now >= windows.resizeQuietUntil &&
    now >= windows.inputQuietUntil
  );
}

export function normalizedIdleThresholdMs(seconds: number): number {
  return Math.max(100, seconds * 1000);
}

export type SessionActivityState = 'active' | 'idle';

export class SessionActivityController {
  private state: SessionActivityState = 'idle';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly windows: ActivityQuietWindows;

  constructor(
    startedAt: number,
    private readonly idleThresholdMs: () => number,
    private readonly onChange: (state: SessionActivityState) => void,
    private readonly timing: { startupGraceMs: number; resizeQuietMs: number; inputQuietMs: number },
  ) {
    this.windows = {
      startupGraceUntil: startedAt + timing.startupGraceMs,
      resizeQuietUntil: 0,
      inputQuietUntil: 0,
    };
  }

  noteInput(text: string, now = Date.now()): void {
    if (this.disposed) return;
    this.windows.inputQuietUntil =
      text.includes('\r') || text.includes('\n') ? 0 : now + this.timing.inputQuietMs;
  }

  noteResize(now = Date.now()): void {
    this.suppressResizeOutputUntil(now + this.timing.resizeQuietMs);
  }

  suppressResizeOutputUntil(until: number): void {
    if (!this.disposed) this.windows.resizeQuietUntil = until;
  }

  noteOutput(now = Date.now()): void {
    if (this.disposed || !outputMarksSessionActive(now, this.windows)) return;
    if (this.state !== 'active') {
      this.state = 'active';
      this.onChange(this.state);
    }
    this.scheduleIdle();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.disposed || this.state !== 'active') return;
      this.state = 'idle';
      this.onChange(this.state);
    }, this.idleThresholdMs());
  }
}
