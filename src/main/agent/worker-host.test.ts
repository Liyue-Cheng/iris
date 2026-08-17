import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  IRIS_AGENT_PROTOCOL_VERSION,
  agentHistoryDigest,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from '@shared/agent-protocol';
import { AgentWorkerHost, resolveAgentWorkerUrl, type AgentWorkerPort } from './worker-host';

class FakeWorker extends EventEmitter implements AgentWorkerPort {
  messages: AgentWorkerRequest[] = [];
  postMessage(message: AgentWorkerRequest): void {
    this.messages.push(message);
  }
  terminate = vi.fn(async () => {
    this.emit('exit', 0);
    return 0;
  });
  emitMessage(message: AgentWorkerEvent): void {
    this.emit('message', message);
  }
}

function readyEvent(
  sessionId: string,
  historyRevision = 1,
  historyMessageCount = 0,
  workerEpoch = 1,
): AgentWorkerEvent {
  const history = {
    revision: historyRevision,
    anchor: { kind: 'workspace' as const, path: '.iris' },
    messages: [],
  };
  return {
    version: IRIS_AGENT_PROTOCOL_VERSION,
    type: 'ready',
    correlation: { sessionId, workerEpoch },
    runtime: {
      protocolVersion: IRIS_AGENT_PROTOCOL_VERSION,
      piVersion: 'test',
      nodeVersion: process.versions.node,
      workerEpoch,
      historyRevision,
      historyMessageCount,
      historyDigest: agentHistoryDigest(history),
    },
  };
}

describe('AgentWorkerHost', () => {
  it('resolves the Worker beside the built main-process bundle', () => {
    expect(resolveAgentWorkerUrl('file:///C:/Iris/resources/app.asar/out/main/app-main.js').href).toBe(
      'file:///C:/Iris/resources/app.asar/out/main/agent-worker.js',
    );
  });

  it('starts lazily, reconstructs from persisted history after exit, and isolates crashes', async () => {
    const workers: FakeWorker[] = [];
    const loadHistory = vi.fn(async () => ({
      revision: workers.length + 1,
      anchor: { kind: 'workspace' as const, path: '.iris' },
      messages: [],
    }));
    const host = new AgentWorkerHost('session-1', {
      loadHistory,
      loadRuntime: async () => ({ cwd: process.cwd(), agentDir: process.cwd() }),
      workerEpoch: 1,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const crashes: number[] = [];
    const workerErrors: string[] = [];
    host.on('crash', (code) => crashes.push(code));
    host.on('workerError', (error: Error) => workerErrors.push(error.message));

    expect(host.running).toBe(false);
    const firstStart = host.ensureStarted();
    await vi.waitFor(() => expect(workers[0]!.messages[0]).toMatchObject({
      type: 'initialize',
      history: { revision: 1 },
    }));
    workers[0]!.emitMessage(readyEvent('session-1'));
    await firstStart;
    expect(workers[0]!.messages[0]).toMatchObject({ type: 'initialize', history: { revision: 1 } });
    workers[0]!.emit('error', new Error('session-local failure'));
    expect(workerErrors).toEqual(['session-local failure']);
    workers[0]!.emit('exit', 9);
    expect(crashes).toEqual([9]);
    expect(host.running).toBe(false);

    const secondStart = host.ensureStarted();
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    workers[1]!.emitMessage(readyEvent('session-1', 2));
    await secondStart;
    expect(loadHistory).toHaveBeenCalledTimes(2);
    expect(workers).toHaveLength(2);
    await host.shutdown();
  });

  it('rejects a ready acknowledgement for a different history revision', async () => {
    const worker = new FakeWorker();
    const host = new AgentWorkerHost('session-1', {
      loadHistory: async () => ({
        revision: 7,
        anchor: { kind: 'workspace', path: '.iris' },
        messages: [],
      }),
      loadRuntime: async () => ({ cwd: process.cwd(), agentDir: process.cwd() }),
      workerEpoch: 1,
      workerFactory: () => worker,
    });
    const started = host.ensureStarted();
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
    worker.emitMessage(readyEvent('session-1', 6));
    await expect(started).rejects.toThrow(/runtime or history identity/);
  });

  it('rejects a ready acknowledgement from a different Worker epoch', async () => {
    const worker = new FakeWorker();
    const host = new AgentWorkerHost('session-1', {
      loadHistory: async () => ({
        revision: 7,
        anchor: { kind: 'workspace', path: '.iris' },
        messages: [],
      }),
      loadRuntime: async () => ({ cwd: process.cwd(), agentDir: process.cwd() }),
      workerEpoch: 4,
      workerFactory: () => worker,
    });
    const started = host.ensureStarted();
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
    worker.emitMessage(readyEvent('session-1', 7, 0, 3));
    await expect(started).rejects.toThrow(/runtime or history identity/);
  });

  it('rejects ready when Pi reports a different loaded message count', async () => {
    const worker = new FakeWorker();
    const host = new AgentWorkerHost('session-1', {
      loadHistory: async () => ({
        revision: 7,
        anchor: { kind: 'workspace', path: '.iris' },
        messages: [],
      }),
      loadRuntime: async () => ({ cwd: process.cwd(), agentDir: process.cwd() }),
      workerEpoch: 1,
      workerFactory: () => worker,
    });
    const started = host.ensureStarted();
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
    worker.emitMessage(readyEvent('session-1', 7, 1));
    await expect(started).rejects.toThrow(/runtime or history identity/);
  });

  it('does not post a first run until worker initialization is ready', async () => {
    const worker = new FakeWorker();
    const host = new AgentWorkerHost('session-1', {
      loadHistory: async () => ({
        revision: 1,
        anchor: { kind: 'workspace', path: '.iris' },
        messages: [],
      }),
      loadRuntime: async () => ({ cwd: process.cwd(), agentDir: process.cwd() }),
      workerEpoch: 1,
      workerFactory: () => worker,
    });

    const posted = host.post({
      type: 'run',
      correlation: { sessionId: 'session-1', workerEpoch: 1, requestId: 'request-1', turnId: 'turn-1' },
      prompt: 'first prompt',
    });
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
    expect(worker.messages[0]).toMatchObject({ type: 'initialize' });

    worker.emitMessage(readyEvent('session-1'));
    await posted;
    expect(worker.messages[1]).toMatchObject({ type: 'run', prompt: 'first prompt' });
    await host.shutdown();
  });

  it('cancels an in-flight startup before shutdown returns', async () => {
    let releaseHistory!: (history: {
      revision: number;
      anchor: { kind: 'workspace'; path: string };
      messages: [];
    }) => void;
    const history = new Promise<{
      revision: number;
      anchor: { kind: 'workspace'; path: string };
      messages: [];
    }>((resolve) => {
      releaseHistory = resolve;
    });
    const workerFactory = vi.fn(() => new FakeWorker());
    const host = new AgentWorkerHost('session-1', {
      loadHistory: async () => history,
      loadRuntime: async () => ({ cwd: process.cwd(), agentDir: process.cwd() }),
      workerEpoch: 1,
      workerFactory,
    });

    const posted = host.post({
      type: 'run',
      correlation: { sessionId: 'session-1', workerEpoch: 1, requestId: 'request-1', turnId: 'turn-1' },
      prompt: 'must not run',
    });
    const rejected = expect(posted).rejects.toThrow(/cancelled|changed/);
    const shutdown = host.shutdown();
    releaseHistory({
      revision: 1,
      anchor: { kind: 'workspace', path: '.iris' },
      messages: [],
    });

    await shutdown;
    await rejected;
    expect(workerFactory).not.toHaveBeenCalled();
    expect(host.running).toBe(false);
  });
});
