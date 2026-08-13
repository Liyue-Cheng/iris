import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { AgentWorkerEvent, AgentWorkerRequest } from '@shared/agent-protocol';
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
    await host.ensureStarted();
    expect(workers[0]!.messages[0]).toMatchObject({ type: 'initialize', history: { revision: 1 } });
    workers[0]!.emit('error', new Error('session-local failure'));
    expect(workerErrors).toEqual(['session-local failure']);
    workers[0]!.emit('exit', 9);
    expect(crashes).toEqual([9]);
    expect(host.running).toBe(false);

    await host.ensureStarted();
    expect(loadHistory).toHaveBeenCalledTimes(2);
    expect(workers).toHaveLength(2);
    await host.shutdown();
  });
});
