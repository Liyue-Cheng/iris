export class ReplayCoordinator {
  private readonly pending = new Map<string, Promise<void>>();

  async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(sessionId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.pending.get(sessionId) === current) this.pending.delete(sessionId);
    }
  }
}
