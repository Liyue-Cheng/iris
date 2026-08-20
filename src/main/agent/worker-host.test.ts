import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  IRIS_AGENT_PROTOCOL_VERSION,
  agentHistoryDigest,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from '@shared/agent-protocol';
import { AgentWorkerHost, resolveAgentWorkerUrl, type AgentWorkerPort } from './worker-host';

const testRuntime = {
  cwd: process.cwd(),
  agentDir: process.cwd(),
  providerProfileRoot: process.cwd(),
  model: { provider: 'openai', modelId: 'gpt-test' },
  commandShell: {
    kind: 'powershell' as const,
    executable: 'pwsh.exe',
    displayName: 'PowerShell 7',
  },
  providerProxy: { mode: 'direct' as const },
};

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
  runtimeOverride: Partial<Extract<AgentWorkerEvent, { type: 'ready' }>['runtime']> = {},
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
      model: testRuntime.model,
      commandShell: testRuntime.commandShell,
      ...runtimeOverride,
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
      loadRuntime: async () => testRuntime,
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
      loadRuntime: async () => testRuntime,
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
      loadRuntime: async () => testRuntime,
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
      loadRuntime: async () => testRuntime,
      workerEpoch: 1,
      workerFactory: () => worker,
    });
    const started = host.ensureStarted();
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
    worker.emitMessage(readyEvent('session-1', 7, 1));
    await expect(started).rejects.toThrow(/runtime or history identity/);
  });

  it.each([
    ['model', { model: { provider: 'openai', modelId: 'gpt-other' } }],
    ['command shell', {
      commandShell: {
        kind: 'powershell' as const,
        executable: 'powershell.exe',
        displayName: 'Windows PowerShell',
      },
    }],
  ])('rejects ready when the Worker acknowledges a different %s', async (_label, override) => {
    const worker = new FakeWorker();
    const host = new AgentWorkerHost('session-1', {
      loadHistory: async () => ({
        revision: 7,
        anchor: { kind: 'workspace', path: '.iris' },
        messages: [],
      }),
      loadRuntime: async () => testRuntime,
      workerEpoch: 1,
      workerFactory: () => worker,
    });
    const started = host.ensureStarted();
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
    worker.emitMessage(readyEvent('session-1', 7, 0, 1, override));
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
      loadRuntime: async () => testRuntime,
      workerEpoch: 1,
      workerFactory: () => worker,
    });

    const posted = host.post({
      type: 'run',
      correlation: { sessionId: 'session-1', workerEpoch: 1, turnId: 'turn-1' },
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
      loadRuntime: async () => testRuntime,
      workerEpoch: 1,
      workerFactory,
    });

    const posted = host.post({
      type: 'run',
      correlation: { sessionId: 'session-1', workerEpoch: 1, turnId: 'turn-1' },
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

describe('Iris Agent Worker provider attempts', () => {
  it('keeps retries inside one provider call and settles only after final success', async () => {
    vi.resetModules();
    const port = new EventEmitter() as EventEmitter & {
      postMessage: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    port.postMessage = vi.fn();
    port.postMessage.mockImplementation((message: unknown) => {
      const event = message as AgentWorkerEvent;
      const eventId = event.eventId;
      if (eventId) {
        queueMicrotask(() => port.emit('message', {
          version: IRIS_AGENT_PROTOCOL_VERSION,
          type: 'event-ack',
          correlation: event.correlation,
          eventId,
          ok: true,
        } satisfies AgentWorkerRequest));
      }
      if (event.type === 'tool-request') {
        queueMicrotask(() => port.emit('message', {
          version: IRIS_AGENT_PROTOCOL_VERSION,
          type: 'tool-result',
          correlation: event.correlation,
          ok: true,
          result: { kind: 'file', contentBase64: Buffer.from(event.correlation.toolCallId ?? '').toString('base64') },
        } satisfies AgentWorkerRequest));
      }
    });
    port.close = vi.fn();
    let subscribe: ((event: unknown) => void) | undefined;
    let providerHooks: {
      onProviderPayload: (payload: unknown, model: ProviderModel) => Promise<void>;
      onProviderFailure: (failure: string | null, model: ProviderModel) => void;
      operations: {
        read: { readFile: (absolutePath: string) => Promise<Buffer> };
      };
    } | undefined;
    const pendingToolCallIds: string[] = [];
    let runCount = 0;
    let releaseAbortedRun: (() => void) | undefined;
    const providerModel: ProviderModel = {
      provider: 'openai',
      id: 'gpt-test',
      api: 'openai-responses',
    };
    const messages: Array<{ role?: unknown; stopReason?: unknown }> = [];
    const prompt = vi.fn(async () => {
      runCount += 1;
      await providerHooks!.onProviderPayload({ model: 'gpt-test' }, providerModel);
      subscribe!({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: `partial-${runCount}` },
      });
      if (runCount === 1) {
        providerHooks!.onProviderFailure('HTTP 503 overloaded', providerModel);
        subscribe!({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'wrapped provider error',
          },
        });
        subscribe!({ type: 'agent_end', willRetry: true });
        subscribe!({ type: 'auto_retry_start', attempt: 1, delayMs: 1, maxAttempts: 2 });
        subscribe!({ type: 'auto_retry_end', success: true, attempt: 1 });
        await providerHooks!.onProviderPayload({ model: 'gpt-test' }, providerModel);
        subscribe!({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'final' },
        });
        subscribe!({
          type: 'message_end',
          message: {
            id: 'provider-final',
            role: 'assistant',
            content: [{ type: 'text', text: 'final' }],
            stopReason: 'stop',
          },
        });
        subscribe!({ type: 'agent_settled' });
        return;
      }
      if (runCount === 2) throw new Error('network timeout');
      if (runCount === 4) {
        await providerHooks!.onProviderPayload({ model: 'gpt-test' }, providerModel);
        subscribe!({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'tool-a', name: 'read', arguments: { path: 'a.md' } },
              { type: 'toolCall', id: 'tool-b', name: 'read', arguments: { path: 'b.md' } },
            ],
            stopReason: 'toolUse',
          },
        });
        pendingToolCallIds.push('tool-a', 'tool-b');
        await Promise.all([
          providerHooks!.operations.read.readFile('a.md'),
          providerHooks!.operations.read.readFile('b.md'),
        ]);
        subscribe!({
          type: 'message_end',
          message: {
            role: 'toolResult', toolCallId: 'tool-a', toolName: 'read',
            content: [{ type: 'text', text: 'a' }], isError: false,
          },
        });
        subscribe!({
          type: 'message_end',
          message: {
            role: 'toolResult', toolCallId: 'tool-b', toolName: 'read',
            content: [{ type: 'text', text: 'b' }], isError: false,
          },
        });
        await providerHooks!.onProviderPayload({ model: 'gpt-test' }, providerModel);
        subscribe!({
          type: 'message_end',
          message: {
            role: 'assistant', content: [{ type: 'text', text: 'both read' }], stopReason: 'stop',
          },
        });
        return;
      }
      await new Promise<void>((resolve) => {
        releaseAbortedRun = resolve;
      });
    });
    const session = {
      state: { messages },
      agent: {
        state: { messages },
        continue: vi.fn(async () => undefined),
      },
      prompt,
      abort: vi.fn(async () => {
        subscribe!({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'visible checkpoint' },
              { type: 'toolCall', id: 'unfinished', name: 'read', arguments: {} },
            ],
            stopReason: 'aborted',
          },
        });
        releaseAbortedRun?.();
      }),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        subscribe = listener;
        return () => undefined;
      }),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort: port }));
    vi.doMock('./pi-adapter', () => ({
      IRIS_PI_VERSION: 'test',
      createIrisPiSession: vi.fn(async (options: typeof providerHooks) => {
        providerHooks = options;
        return {
          session,
          disposeProviderTransport: async () => undefined,
        };
      }),
      currentIrisProviderToolCallId: () => pendingToolCallIds.shift(),
      storedPiCredentialSecrets: () => [],
      unwrapProviderErrorMessage: (wrapped: string, captured: string | null) => captured ?? wrapped,
      normalizeIrisInterruptedAssistantMessage: (message: { content?: Array<{ type?: string; text?: string }> }) => ({
        ...message,
        content: message.content?.filter((block) => block.type === 'text') ?? [],
        stopReason: 'stop',
      }),
    }));
    vi.doMock('./provider-profiles', () => ({
      loadStoredIrisAgentProviderProfiles: async () => [],
    }));

    await import('../agent-worker');
    port.emit('message', {
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'initialize',
      correlation: { sessionId: 'session-1', workerEpoch: 1 },
      history: {
        revision: 1,
        anchor: { kind: 'workspace', path: '.iris' },
        messages: [],
      },
      runtime: testRuntime,
    } satisfies AgentWorkerRequest);
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ready' }),
    ));

    const firstCorrelation = {
      sessionId: 'session-1',
      workerEpoch: 1,
      turnId: 'turn-1',
    };
    port.emit('message', {
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'run',
      correlation: firstCorrelation,
      prompt: 'first',
    } satisfies AgentWorkerRequest);
    await vi.waitFor(() => expect(workerEvents(port)).toContainEqual(
      expect.objectContaining({ type: 'execution-settled', correlation: firstCorrelation }),
    ));

    const firstEvents = workerEvents(port);
    const attemptStarts = firstEvents.filter(
      (event): event is Extract<AgentWorkerEvent, { type: 'provider-attempt' }> =>
        event.type === 'provider-attempt' && event.phase === 'started',
    );
    expect(attemptStarts.map((event) => event.index)).toEqual([1, 2]);
    expect(new Set(attemptStarts.map((event) => event.correlation.providerCallId)).size).toBe(1);
    expect(new Set(attemptStarts.map((event) => event.correlation.attemptId)).size).toBe(2);
    expect(firstEvents).toContainEqual(expect.objectContaining({ type: 'state', state: 'retry-wait' }));
    expect(firstEvents).toContainEqual(expect.objectContaining({
      type: 'provider-attempt',
      phase: 'failed',
      index: 1,
      error: 'HTTP 503 overloaded',
    }));
    expect(firstEvents.filter((event) => event.type === 'execution-settled')).toHaveLength(1);
    expect(firstEvents.filter((event) =>
      event.type === 'provider-message' && event.message.stopReason === 'error')).toHaveLength(0);
    const finalDelta = firstEvents.find(
      (event): event is Extract<AgentWorkerEvent, { type: 'assistant-text-delta' }> =>
        event.type === 'assistant-text-delta' && event.delta === 'final',
    );
    const finalMessage = firstEvents.find(
      (event): event is Extract<AgentWorkerEvent, { type: 'provider-message' }> =>
        event.type === 'provider-message' && event.message.id === 'provider-final',
    );
    expect(finalDelta?.correlation.providerMessageId).toBe(finalMessage?.correlation.providerMessageId);

    port.postMessage.mockClear();
    const secondCorrelation = {
      sessionId: 'session-1',
      workerEpoch: 1,
      turnId: 'turn-2',
    };
    port.emit('message', {
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'run',
      correlation: secondCorrelation,
      prompt: 'second',
    } satisfies AgentWorkerRequest);
    await vi.waitFor(() => expect(workerEvents(port)).toContainEqual(expect.objectContaining({
      type: 'execution-paused',
      correlation: expect.objectContaining(secondCorrelation),
      message: 'network timeout',
    })));
    const secondEvents = workerEvents(port);
    expect(secondEvents).toContainEqual(expect.objectContaining({
      type: 'provider-attempt',
      phase: 'failed',
      index: 1,
      error: 'network timeout',
    }));
    expect(secondEvents.some((event) => event.type === 'execution-settled')).toBe(false);

    port.postMessage.mockClear();
    const thirdCorrelation = {
      sessionId: 'session-1',
      workerEpoch: 1,
      turnId: 'turn-3',
    };
    port.emit('message', {
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'run',
      correlation: thirdCorrelation,
      prompt: 'third',
    } satisfies AgentWorkerRequest);
    await vi.waitFor(() => expect(workerEvents(port)).toContainEqual(expect.objectContaining({
      type: 'provider-attempt',
      phase: 'started',
    })));
    port.emit('message', {
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'abort',
      correlation: thirdCorrelation,
      reason: 'user',
    } satisfies AgentWorkerRequest);
    await vi.waitFor(() => expect(workerEvents(port)).toContainEqual(expect.objectContaining({
      type: 'state',
      state: 'interrupted',
    })));
    const abortedEvents = workerEvents(port);
    expect(abortedEvents).toContainEqual(expect.objectContaining({
      type: 'provider-attempt',
      phase: 'aborted',
      index: 1,
    }));
    expect(abortedEvents).toContainEqual(expect.objectContaining({
      type: 'provider-message',
      message: expect.objectContaining({
        content: [{ type: 'text', text: 'visible checkpoint' }],
        stopReason: 'stop',
      }),
    }));
    expect(abortedEvents.some((event) => event.type === 'execution-settled')).toBe(false);

    port.postMessage.mockClear();
    const fourthCorrelation = {
      sessionId: 'session-1',
      workerEpoch: 1,
      turnId: 'turn-4',
    };
    port.emit('message', {
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'run',
      correlation: fourthCorrelation,
      prompt: 'two tools',
    } satisfies AgentWorkerRequest);
    await vi.waitFor(() => expect(workerEvents(port)).toContainEqual(
      expect.objectContaining({ type: 'execution-settled', correlation: fourthCorrelation }),
    ));
    const fourthEvents = workerEvents(port);
    const toolRequests = fourthEvents.filter(
      (event): event is Extract<AgentWorkerEvent, { type: 'tool-request' }> => event.type === 'tool-request',
    );
    expect(toolRequests.map((event) => event.correlation.toolCallId)).toEqual(['tool-a', 'tool-b']);
    const toolResults = fourthEvents.filter(
      (event): event is Extract<AgentWorkerEvent, { type: 'provider-message' }> =>
        event.type === 'provider-message' && event.message.role === 'toolResult',
    );
    expect(toolResults).toHaveLength(2);
    expect(new Set(toolResults.map((event) => event.correlation.providerMessageId)).size).toBe(2);
    expect(toolResults.every((event) => event.correlation.providerCallId === undefined)).toBe(true);
    const fourthStarts = fourthEvents.filter(
      (event): event is Extract<AgentWorkerEvent, { type: 'provider-attempt' }> =>
        event.type === 'provider-attempt' && event.phase === 'started',
    );
    expect(new Set(fourthStarts.map((event) => event.correlation.providerCallId)).size).toBe(2);
  });
});

interface ProviderModel {
  provider: string;
  id: string;
  api: string;
}

function workerEvents(port: { postMessage: ReturnType<typeof vi.fn> }): AgentWorkerEvent[] {
  return port.postMessage.mock.calls.map(([event]) => event as AgentWorkerEvent);
}
