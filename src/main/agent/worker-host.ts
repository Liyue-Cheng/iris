import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import {
  IRIS_AGENT_PROTOCOL_VERSION,
  agentHistoryDigest,
  type AgentHistorySnapshot,
  type AgentWorkerInitRuntime,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from '@shared/agent-protocol';

export interface AgentWorkerPort {
  postMessage(message: AgentWorkerRequest): void;
  on(event: 'message', listener: (message: AgentWorkerEvent) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

export interface AgentWorkerHostOptions {
  loadHistory(sessionId: string): Promise<AgentHistorySnapshot>;
  loadRuntime(sessionId: string): Promise<AgentWorkerInitRuntime>;
  workerEpoch: number;
  workerFactory?: () => AgentWorkerPort;
  idleTimeoutMs?: number;
}

type AgentWorkerRequestWithoutVersion<T = AgentWorkerRequest> = T extends AgentWorkerRequest
  ? Omit<T, 'version'>
  : never;

export class AgentWorkerHost extends EventEmitter {
  private worker: AgentWorkerPort | null = null;
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private readonly expectedExits = new Set<AgentWorkerPort>();

  constructor(
    readonly sessionId: string,
    private readonly options: AgentWorkerHostOptions,
  ) {
    super();
  }

  get workerEpoch(): number {
    return this.options.workerEpoch;
  }

  get running(): boolean {
    return this.worker !== null;
  }

  async ensureStarted(): Promise<void> {
    if (this.shutdownPromise) await this.shutdownPromise;
    if (this.startPromise) return this.startPromise;
    if (this.worker) return;
    this.startPromise = this.start(this.generation);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async post(request: AgentWorkerRequestWithoutVersion): Promise<void> {
    if (this.shutdownPromise) await this.shutdownPromise;
    const generation = this.generation;
    await this.ensureStarted();
    const worker = this.worker;
    if (!worker || generation !== this.generation) {
      throw new Error('Iris Agent Worker changed while a request was waiting to be posted.');
    }
    this.clearIdleTimer();
    worker.postMessage({ ...request, version: IRIS_AGENT_PROTOCOL_VERSION } as AgentWorkerRequest);
  }

  markIdle(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => void this.shutdown('idle-timeout'), this.options.idleTimeoutMs ?? 60_000);
  }

  async shutdown(reason: 'idle-timeout' | 'shutdown' = 'shutdown'): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.clearIdleTimer();
    this.generation += 1;
    const shutdownPromise = this.shutdownNow(reason);
    this.shutdownPromise = shutdownPromise;
    try {
      await shutdownPromise;
    } finally {
      if (this.shutdownPromise === shutdownPromise) this.shutdownPromise = null;
    }
  }

  private async shutdownNow(reason: 'idle-timeout' | 'shutdown'): Promise<void> {
    const startPromise = this.startPromise;
    const worker = this.worker;
    if (worker) {
      this.worker = null;
      this.expectedExits.add(worker);
      worker.postMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'shutdown',
        correlation: { sessionId: this.sessionId, workerEpoch: this.workerEpoch },
      });
      try {
        await worker.terminate();
      } finally {
        this.expectedExits.delete(worker);
      }
    }
    if (startPromise) await startPromise.catch(() => undefined);
    if (worker || startPromise) this.emit('stopped', reason);
  }

  private async start(generation: number): Promise<void> {
    const [history, runtime] = await Promise.all([
      this.options.loadHistory(this.sessionId),
      this.options.loadRuntime(this.sessionId),
    ]);
    if (generation !== this.generation) {
      throw new Error('Iris Agent Worker startup was cancelled.');
    }
    const worker = this.options.workerFactory?.() ?? createNodeWorker();
    this.worker = worker;
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      worker.on('message', (event) => {
        this.emit('event', event);
        if (event.type === 'ready') {
          if (
            event.correlation.sessionId !== this.sessionId ||
            event.correlation.workerEpoch !== this.workerEpoch ||
            event.runtime.protocolVersion !== IRIS_AGENT_PROTOCOL_VERSION ||
            event.runtime.workerEpoch !== this.workerEpoch ||
            event.runtime.historyRevision !== history.revision ||
            event.runtime.historyMessageCount !== history.messages.length ||
            event.runtime.historyDigest !== agentHistoryDigest(history) ||
            event.runtime.model.provider !== runtime.model.provider ||
            event.runtime.model.modelId !== runtime.model.modelId ||
            event.runtime.commandShell.kind !== runtime.commandShell.kind ||
            event.runtime.commandShell.executable !== runtime.commandShell.executable
          ) {
            settle(() => reject(new Error(
              'Iris Agent Worker acknowledged a different runtime or history identity.',
            )));
          } else {
            settle(resolve);
          }
        }
        if (event.type === 'failure') settle(() => reject(new Error(event.message)));
      });
      worker.on('error', (error) => {
        this.emit('workerError', error);
        settle(() => reject(error));
      });
      worker.on('exit', (code) => {
        if (this.worker === worker) this.worker = null;
        if (!this.expectedExits.delete(worker)) this.emit('crash', code);
        settle(() => reject(new Error('Iris Agent Worker exited before initialization with code ' + String(code))));
      });
    });
    worker.postMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'initialize',
      correlation: { sessionId: this.sessionId, workerEpoch: this.workerEpoch },
      history,
      runtime,
    });
    try {
      await ready;
      if (generation !== this.generation || this.worker !== worker) {
        throw new Error('Iris Agent Worker startup was cancelled.');
      }
    } catch (err) {
      if (this.worker === worker) {
        this.expectedExits.add(worker);
        this.worker = null;
        try {
          await worker.terminate();
        } finally {
          this.expectedExits.delete(worker);
        }
      }
      throw err;
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function createNodeWorker(): AgentWorkerPort {
  return new Worker(resolveAgentWorkerUrl(import.meta.url)) as AgentWorkerPort;
}

export function resolveAgentWorkerUrl(hostModuleUrl: string): URL {
  return new URL('./agent-worker.js', hostModuleUrl);
}
