import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import {
  IRIS_AGENT_PROTOCOL_VERSION,
  type AgentHistorySnapshot,
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
  workerFactory?: () => AgentWorkerPort;
  idleTimeoutMs?: number;
}

type AgentWorkerRequestWithoutVersion<T = AgentWorkerRequest> = T extends AgentWorkerRequest
  ? Omit<T, 'version'>
  : never;

export class AgentWorkerHost extends EventEmitter {
  private worker: AgentWorkerPort | null = null;
  private startPromise: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private expectedExit = false;

  constructor(
    readonly sessionId: string,
    private readonly options: AgentWorkerHostOptions,
  ) {
    super();
  }

  get running(): boolean {
    return this.worker !== null;
  }

  async ensureStarted(): Promise<void> {
    if (this.worker) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async post(request: AgentWorkerRequestWithoutVersion): Promise<void> {
    await this.ensureStarted();
    this.clearIdleTimer();
    this.worker!.postMessage({ ...request, version: IRIS_AGENT_PROTOCOL_VERSION } as AgentWorkerRequest);
  }

  markIdle(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => void this.shutdown('idle-timeout'), this.options.idleTimeoutMs ?? 60_000);
  }

  async shutdown(reason: 'idle-timeout' | 'shutdown' = 'shutdown'): Promise<void> {
    this.clearIdleTimer();
    const worker = this.worker;
    if (!worker) return;
    this.expectedExit = true;
    worker.postMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'shutdown',
      correlation: { sessionId: this.sessionId },
    });
    await worker.terminate();
    if (this.worker === worker) this.worker = null;
    this.emit('stopped', reason);
  }

  private async start(): Promise<void> {
    const history = await this.options.loadHistory(this.sessionId);
    const worker = this.options.workerFactory?.() ?? createNodeWorker();
    this.expectedExit = false;
    this.worker = worker;
    worker.on('message', (event) => this.emit('event', event));
    worker.on('error', (error) => this.emit('workerError', error));
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null;
      if (!this.expectedExit) this.emit('crash', code);
    });
    worker.postMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'initialize',
      correlation: { sessionId: this.sessionId },
      history,
    });
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
