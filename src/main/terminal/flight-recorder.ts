export interface TerminalFlightEvent {
  atMs: number;
  type: string;
  details?: Record<string, string | number | boolean | null>;
}

export class TerminalFlightRecorder {
  private readonly events: TerminalFlightEvent[] = [];

  constructor(
    private readonly capacity = 128,
    private readonly now = () => performance.now(),
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('flight recorder capacity');
  }

  record(
    type: string,
    details?: Record<string, string | number | boolean | null>,
  ): void {
    this.events.push({ atMs: this.now(), type, ...(details ? { details } : {}) });
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
  }

  snapshot(): TerminalFlightEvent[] {
    return this.events.map((event) => ({
      ...event,
      ...(event.details ? { details: { ...event.details } } : {}),
    }));
  }
}
