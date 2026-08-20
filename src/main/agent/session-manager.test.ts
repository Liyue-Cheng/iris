import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  IRIS_AGENT_PROTOCOL_VERSION,
  agentHistoryDigest,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from '@shared/agent-protocol';
import type { IrisAgentModelCatalog, ProjectScope } from '@shared/types';
import type { ProjectManager } from '../project-manager';
import { createTempDataDir, JsonStore, removeTempDataDir } from '../persistence';
import { SettingsManager } from '../settings-manager';
import type { AgentWorkerPort } from './worker-host';
import type { IrisAgentToolHostResult } from './tool-host';
import type { AgentCommandPty, AgentCommandPtyOptions, AgentCommandPtyResult } from './command-pty';
import { IrisAgentSessionManager, parseElectronProxyRules } from './session-manager';
import { IrisAgentSessionStore } from './session-store';

const catalog: IrisAgentModelCatalog = {
  models: [{
    provider: 'openai', modelId: 'gpt-test', name: 'GPT Test',
    api: 'openai-responses', reasoning: true,
  }],
};

class FakeWorker extends EventEmitter implements AgentWorkerPort {
  readonly messages: AgentWorkerRequest[] = [];

  constructor(private readonly autoReady = true) {
    super();
  }

  postMessage(message: AgentWorkerRequest): void {
    this.messages.push(message);
    if (message.type === 'initialize' && this.autoReady) queueMicrotask(() => this.emitReady());
  }

  terminate = vi.fn(async () => {
    this.emit('exit', 0);
    return 0;
  });

  emitMessage(message: AgentWorkerEvent): void {
    this.emit('message', message);
  }

  emitReady(): void {
    const message = this.last('initialize');
    this.emitMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'ready',
      correlation: message.correlation,
      runtime: {
        protocolVersion: IRIS_AGENT_PROTOCOL_VERSION,
        piVersion: 'test',
        nodeVersion: process.versions.node,
        workerEpoch: message.correlation.workerEpoch ?? 0,
        historyRevision: message.history.revision,
        historyMessageCount: message.history.messages.length,
        historyDigest: agentHistoryDigest(message.history),
        model: message.runtime.model,
        commandShell: message.runtime.commandShell,
      },
    });
  }

  last<T extends AgentWorkerRequest['type']>(type: T): Extract<AgentWorkerRequest, { type: T }> {
    const message = [...this.messages].reverse().find((candidate) => candidate.type === type);
    if (!message) throw new Error(`Missing Worker request ${type}`);
    return message as Extract<AgentWorkerRequest, { type: T }>;
  }
}

class FakeInteractiveTerminal {
  private cursor = 0;
  private text = '';
  private running = true;
  private resolveResult!: (result: AgentCommandPtyResult) => void;
  readonly result: Promise<AgentCommandPtyResult>;

  constructor(private readonly options: AgentCommandPtyOptions) {
    this.result = new Promise((resolve) => { this.resolveResult = resolve; });
    queueMicrotask(() => {
      this.emitOutput('first');
      options.onEvent?.({ type: 'shown', terminalId: options.terminalId });
    });
  }

  abort(): void {
    if (this.running) this.complete(130);
  }

  write(data: string): void {
    if (!this.running) return;
    if (data.includes('one')) this.emitOutput('one\r\nsecond:one');
    if (data.includes('two')) {
      this.emitOutput('two\r\ndone:two');
      this.complete(0);
    }
  }

  resize(): void {}

  dispose(): void {}

  async replay(): Promise<{ data: string; cursor: number }> {
    return { data: Buffer.from(this.text).toString('base64'), cursor: this.cursor };
  }

  async observation(): Promise<{ cursor: number; text: string; running: boolean }> {
    return { cursor: this.cursor, text: this.text, running: this.running };
  }

  private emitOutput(value: string): void {
    const cursor = this.cursor;
    this.cursor += Buffer.byteLength(value);
    this.text += value;
    this.options.onEvent?.({
      type: 'output',
      terminalId: this.options.terminalId,
      cursor,
      data: Buffer.from(value).toString('base64'),
    });
  }

  private complete(exitCode: number): void {
    if (!this.running) return;
    this.running = false;
    const result: AgentCommandPtyResult = {
      terminalId: this.options.terminalId,
      exitCode,
      outputPath: this.options.outputPath,
      outputBytes: this.cursor,
      finalCursor: this.cursor,
      shown: true,
      plainText: this.text,
      outputTruncated: false,
    };
    this.options.onEvent?.({ type: 'completed', terminalId: this.options.terminalId, result });
    this.resolveResult(result);
  }
}

function projectManager(): ProjectManager {
  return {
    softwarePromptState: vi.fn(async () => ({
      project: { text: '', source: 'default', configured: false, error: null },
    })),
    readDoc: vi.fn(async (path: string) => ({ path, raw: '# Focus' })),
  } as unknown as ProjectManager;
}

function providerCorrelation(
  request: Extract<AgentWorkerRequest, { type: 'run' | 'resume' }>,
  suffix: string,
) {
  return {
    ...request.correlation,
    providerCallId: `call-${suffix}`,
    attemptId: `attempt-${suffix}`,
    providerMessageId: `message-${suffix}`,
  };
}

function emitReply(
  worker: FakeWorker,
  request: Extract<AgentWorkerRequest, { type: 'run' | 'resume' }>,
  suffix: string,
  content: string,
): void {
  const correlation = providerCorrelation(request, suffix);
  worker.emitMessage({
    version: IRIS_AGENT_PROTOCOL_VERSION,
    type: 'provider-attempt',
    correlation,
    phase: 'started',
    index: 1,
  });
  worker.emitMessage({
    version: IRIS_AGENT_PROTOCOL_VERSION,
    type: 'assistant-text-delta',
    correlation,
    delta: content,
  });
}

describe('IrisAgentSessionManager v2 timeline', () => {
  it('publishes the accepted user message before a cold Worker becomes ready', async () => {
    const userData = await createTempDataDir('iris-agent-manager-cold-message-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker(false);
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({
        scope,
        anchor: { kind: 'workspace', path: '.iris' },
      });
      let settled = false;
      const sending = manager.send(scope, created.id, 'visible immediately').then(() => {
        settled = true;
      });

      await vi.waitFor(async () => {
        const projected = (await manager.list(scope)).sessions[0]!;
        expect(projected.state).toBe('starting');
        expect(projected.turns[0]?.user.content).toBe('visible immediately');
        expect(worker.messages.some((message) => message.type === 'initialize')).toBe(true);
      });
      expect(settled).toBe(false);

      worker.emitReady();
      await sending;
      expect((await manager.list(scope)).sessions[0]?.state).toBe('running');
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('keeps stopped Reply A and appends completed Reply B when continuing the same Turn', async () => {
    const userData = await createTempDataDir('iris-agent-manager-v2-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const workers: FakeWorker[] = [];
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({
        scope,
        anchor: { kind: 'document', path: '.iris/issue/task.md' },
      });
      await manager.send(scope, created.id, 'do work', { expectedRevision: created.revision });
      const worker = workers[0]!;
      expect(worker.last('initialize').history.messages).toEqual([]);
      const run = worker.last('run');
      emitReply(worker, run, 'a', 'partial A');
      await vi.waitFor(async () => {
        expect((await manager.list(scope)).sessions[0]?.turns[0]?.cards[0]).toMatchObject({
          id: 'reply:message-a', content: 'partial A', state: 'running',
        });
      });

      const beforeStop = (await manager.list(scope)).sessions[0]!;
      await manager.stop(scope, created.id, { expectedRevision: beforeStop.revision });
      expect(worker.terminate).toHaveBeenCalledOnce();
      await vi.waitFor(async () => {
        expect((await manager.list(scope)).sessions[0]?.pause?.reason).toBe('user');
      });

      const paused = (await manager.list(scope)).sessions[0]!;
      await manager.retry(scope, created.id, { expectedRevision: paused.revision });
      const resumedWorker = workers[1]!;
      expect(resumedWorker.last('initialize').history.messages).toEqual([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('<user-request>\ndo work\n</user-request>'),
        }),
      ]);
      const resume = resumedWorker.last('resume');
      expect(resume.correlation.turnId).toBe(run.correlation.turnId);
      emitReply(resumedWorker, resume, 'b', 'answer B');
      const correlation = providerCorrelation(resume, 'b');
      resumedWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        correlation,
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer B' }], stopReason: 'stop' },
      });
      resumedWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'assistant-text-delta',
        correlation,
        delta: ' LATE',
      });
      resumedWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt',
        correlation,
        phase: 'completed',
        index: 1,
      });
      resumedWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'execution-settled',
        correlation: resume.correlation,
      });
      await vi.waitFor(async () => {
        const cards = (await manager.list(scope)).sessions[0]?.turns[0]?.cards;
        expect(cards?.map((card) => [card.id, card.state])).toEqual([
          ['reply:message-a', 'stopped'],
          ['reply:message-b', 'completed'],
        ]);
        expect(cards?.[1]).toMatchObject({ content: 'answer B' });
      });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('does not create a fake Reply for a provider failure without visible text', async () => {
    const userData = await createTempDataDir('iris-agent-manager-failure-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, 'fail', { expectedRevision: created.revision });
      const run = worker.last('run');
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'execution-paused',
        correlation: run.correlation,
        reason: 'provider-exhausted',
        message: 'rate limited',
      });
      await vi.waitFor(async () => {
        const projected = (await manager.list(scope)).sessions[0]!;
        expect(projected.pause).toEqual({ reason: 'provider', message: 'rate limited' });
        expect(projected.turns[0]?.cards).toEqual([]);
      });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('serializes queued Worker deltas before a Stop command without losing the Reply', async () => {
    const userData = await createTempDataDir('iris-agent-manager-race-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, 'race');
      const run = worker.last('run');
      const turnId = run.correlation.turnId;
      expect(turnId).toBeDefined();
      if (!turnId) throw new Error('Run request is missing turnId');
      emitReply(worker, run, 'race', 'kept before stop');

      await manager.stop(scope, created.id, {
        expectedRevision: created.revision,
        expectedTurnId: turnId,
      });
      expect(worker.terminate).toHaveBeenCalledOnce();

      await vi.waitFor(async () => {
        const projected = (await manager.list(scope)).sessions[0]!;
        expect(projected.pause?.reason).toBe('user');
        expect(projected.turns[0]?.cards).toEqual([
          expect.objectContaining({
            id: 'reply:message-race',
            content: 'kept before stop',
            state: 'stopped',
          }),
        ]);
      });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('keeps Stop responsive while a main-owned tool operation is still executing', async () => {
    const userData = await createTempDataDir('iris-agent-manager-tool-stop-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const workers: FakeWorker[] = [];
    let settleTool!: (result: IrisAgentToolHostResult) => void;
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      modelCatalogLoader: async () => catalog,
      toolExecutor: () => new Promise((resolve) => { settleTool = resolve; }),
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, 'read');
      const worker = workers[0]!;
      const run = worker.last('run');
      const correlation = {
        ...providerCorrelation(run, 'tool'),
        toolCallId: 'tool-1',
        operationId: 'operation-1',
      };
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt',
        correlation,
        phase: 'started',
        index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        correlation,
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tool-1', name: 'read', arguments: {} }],
          stopReason: 'toolUse',
        },
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'tool-request',
        correlation,
        input: { tool: 'read', operation: 'readFile', absolutePath: 'README.md' },
      });
      await vi.waitFor(async () => {
        expect((await manager.list(scope)).sessions[0]?.state).toBe('waiting-tool');
      });

      let stopCompleted = false;
      const stopping = manager.stop(scope, created.id).then(() => { stopCompleted = true; });
      await vi.waitFor(() => expect(stopCompleted).toBe(true));
      await stopping;
      expect(worker.terminate).toHaveBeenCalledOnce();
      await vi.waitFor(async () => {
        expect((await manager.list(scope)).sessions[0]?.turns[0]?.cards[0]?.state).toBe('stopped');
      });

      const paused = (await manager.list(scope)).sessions[0]!;
      await manager.retry(scope, created.id, { expectedRevision: paused.revision });
      const resumedWorker = workers[1]!;
      expect(resumedWorker.last('initialize').history.messages.at(-1)).toMatchObject({
        role: 'tool',
        providerMessage: {
          role: 'toolResult', toolCallId: 'tool-1', isError: true,
        },
      });
      expect(resumedWorker.last('resume').correlation.turnId).toBe(run.correlation.turnId);

      settleTool({
        result: { kind: 'file', contentBase64: '' },
        update: { state: 'completed', completedAt: Date.now(), resultSummary: '0 bytes', path: 'README.md' },
        effects: [{
          id: 'late-effect',
          turnId: run.correlation.turnId!,
          toolActivityId: 'tool-1',
          kind: 'terminal-output',
          artifactRef: 'effects/late-effect.json',
          createdAt: Date.now(),
        }],
      });
      await vi.waitFor(async () => {
        const card = (await manager.list(scope)).sessions[0]?.turns[0]?.cards[0];
        expect(card).toMatchObject({ state: 'stopped' });
        expect(card?.kind === 'local-retrieval' ? card.items[0]?.detail : undefined).toBeUndefined();
      });
      expect(resumedWorker.messages.some((message) => message.type === 'tool-result')).toBe(false);
      const persisted = (await IrisAgentSessionStore.load({
        userDataPath: userData,
        projectRoot: scope.root,
      })).get(created.id)!;
      expect(persisted.toolOperations[0]).toMatchObject({ state: 'failed', error: 'Paused by user.' });
      expect(persisted.effects).toContainEqual(expect.objectContaining({ id: 'late-effect' }));
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('commits ProviderCall -> ToolCall -> ToolResult before continuing to the final ProviderCall', async () => {
    const userData = await createTempDataDir('iris-agent-manager-tool-chain-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      toolExecutor: async () => ({
        result: { kind: 'file', contentBase64: Buffer.from('contents').toString('base64') },
        update: {
          state: 'completed', completedAt: Date.now(), resultSummary: '8 bytes', path: 'README.md',
        },
        effects: [],
      }),
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, 'inspect');
      const run = worker.last('run');
      const first = providerCorrelation(run, 'tool-parent');
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: first, phase: 'started', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        eventId: 'event-assistant-tool',
        correlation: first,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading.' },
            { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'README.md' } },
          ],
          stopReason: 'toolUse',
        },
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: first, phase: 'completed', index: 1,
      });
      await vi.waitFor(() => expect(worker.messages).toContainEqual(expect.objectContaining({
        type: 'event-ack', eventId: 'event-assistant-tool', ok: true,
      })));
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'tool-request',
        correlation: {
          ...run.correlation,
          toolCallId: 'tool-1',
          operationId: 'operation-1',
        },
        input: { tool: 'read', operation: 'readFile', absolutePath: 'README.md' },
      });
      await vi.waitFor(() => expect(worker.last('tool-result')).toMatchObject({
        correlation: { toolCallId: 'tool-1', operationId: 'operation-1' },
        ok: true,
      }));

      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        eventId: 'event-tool-result',
        correlation: {
          ...run.correlation,
          toolCallId: 'tool-1',
          providerMessageId: 'message-tool-result',
        },
        message: {
          role: 'toolResult', toolCallId: 'tool-1', content: [{ type: 'text', text: 'contents' }],
          isError: false,
        },
      });
      await vi.waitFor(() => expect(worker.messages).toContainEqual(expect.objectContaining({
        type: 'event-ack', eventId: 'event-tool-result', ok: true,
      })));
      const second = {
        ...run.correlation,
        providerCallId: 'call-final',
        attemptId: 'attempt-final',
        providerMessageId: 'message-final',
      };
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: second, phase: 'started', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        correlation: second,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' },
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: second, phase: 'completed', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'execution-settled', correlation: run.correlation,
      });

      await vi.waitFor(async () => {
        const projected = (await manager.list(scope)).sessions[0]!;
        expect(projected.state).toBe('idle');
        expect(projected.turns[0]?.state).toBe('fulfilled');
      });
      const persisted = (await IrisAgentSessionStore.load({
        userDataPath: userData,
        projectRoot: scope.root,
      })).get(created.id)!;
      expect(persisted.providerCalls.map((call) => call.id)).toEqual(['call-tool-parent', 'call-final']);
      expect(persisted.transcript.map((frame) => frame.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
      expect(persisted.transcript[1]).toMatchObject({ providerCallId: 'call-tool-parent' });
      expect(persisted.transcript[2]).toMatchObject({ toolCallId: 'tool-1' });
      expect(persisted.timeline.find((activity) => activity.kind === 'tool')).toMatchObject({
        providerCallId: 'call-tool-parent', toolCallId: 'tool-1', state: 'completed',
      });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('NACKs a failed durable commit and terminates the Worker before exposing paused', async () => {
    const userData = await createTempDataDir('iris-agent-manager-commit-failure-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
    });
    const originalCommit = IrisAgentSessionStore.prototype.commit;
    let rejectNextCommit = false;
    const commit = vi.spyOn(IrisAgentSessionStore.prototype, 'commit').mockImplementation(async function (
      this: IrisAgentSessionStore,
      source,
    ) {
      if (rejectNextCommit) {
        rejectNextCommit = false;
        throw new Error('simulated durable commit failure');
      }
      if (source.turns.some((turn) => turn.state === 'paused')) {
        expect(worker.terminate).toHaveBeenCalledOnce();
      }
      return originalCommit.call(this, source);
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, 'fail commit');
      const run = worker.last('run');
      rejectNextCommit = true;
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt',
        eventId: 'event-failing-commit',
        correlation: providerCorrelation(run, 'failing-commit'),
        phase: 'started',
        index: 1,
      });

      await vi.waitFor(() => expect(worker.messages).toContainEqual(expect.objectContaining({
        type: 'event-ack', eventId: 'event-failing-commit', ok: false,
        error: 'simulated durable commit failure',
      })));
      await vi.waitFor(async () => {
        const projected = (await manager.list(scope)).sessions[0]!;
        expect(projected.state).toBe('paused');
        expect(projected.pause).toMatchObject({ reason: 'runtime', message: 'simulated durable commit failure' });
      });
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      commit.mockRestore();
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('finishes a committed final assistant when execution fails before settled', async () => {
    const userData = await createTempDataDir('iris-agent-manager-final-boundary-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, 'finish despite late failure');
      const run = worker.last('run');
      const correlation = providerCorrelation(run, 'final-boundary');
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation, phase: 'started', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        correlation,
        message: {
          role: 'assistant', content: [{ type: 'text', text: 'Committed answer.' }], stopReason: 'stop',
        },
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'execution-paused',
        correlation: run.correlation,
        reason: 'runtime-error',
        message: 'failed after the final message commit',
      });

      await vi.waitFor(async () => {
        const projected = (await manager.list(scope)).sessions[0]!;
        expect(projected.state).toBe('idle');
        expect(projected.pause).toBeUndefined();
        expect(projected.turns[0]).toMatchObject({ state: 'fulfilled' });
        expect(projected.turns[0]?.cards[0]).toMatchObject({
          content: 'Committed answer.', state: 'completed',
        });
      });
      expect(worker.terminate).toHaveBeenCalledOnce();
      const persisted = (await IrisAgentSessionStore.load({
        userDataPath: userData,
        projectRoot: scope.root,
      })).get(created.id)!;
      expect(persisted.providerCalls[0]).toMatchObject({ state: 'completed' });
      expect(persisted.providerAttempts[0]).toMatchObject({ state: 'completed' });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('materializes an interrupted result when stopping between toolCall commit and tool request', async () => {
    const userData = await createTempDataDir('iris-agent-manager-tool-boundary-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const workers: FakeWorker[] = [];
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, 'stop before tool request');
      const firstWorker = workers[0]!;
      const run = firstWorker.last('run');
      const correlation = providerCorrelation(run, 'unrequested-tool');
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation, phase: 'started', index: 1,
      });
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        correlation,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'About to read.' },
            { type: 'toolCall', id: 'tool-before-request', name: 'read', arguments: { path: 'README.md' } },
          ],
          stopReason: 'toolUse',
        },
      });
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'execution-paused',
        correlation: run.correlation,
        reason: 'runtime-error',
        message: 'worker stopped before tool dispatch',
      });

      await vi.waitFor(async () => {
        expect((await manager.list(scope)).sessions[0]?.state).toBe('paused');
      });
      const paused = (await manager.list(scope)).sessions[0]!;
      await manager.retry(scope, created.id, { expectedRevision: paused.revision });
      const resumedWorker = workers[1]!;
      expect(resumedWorker.last('initialize').history.messages.slice(-2)).toMatchObject([
        {
          role: 'assistant',
          providerMessage: { stopReason: 'toolUse' },
        },
        {
          role: 'tool',
          providerMessage: {
            role: 'toolResult', toolCallId: 'tool-before-request', isError: true,
          },
        },
      ]);
      expect(resumedWorker.last('resume').correlation.turnId).toBe(run.correlation.turnId);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('keeps an aborted partial Reply visible but excludes it from restart history', async () => {
    const userData = await createTempDataDir('iris-agent-manager-aborted-history-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const firstWorker = new FakeWorker();
    const firstManager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => firstWorker,
      modelCatalogLoader: async () => catalog,
    });
    let secondManager: IrisAgentSessionManager | null = null;
    try {
      await firstManager.listModels();
      const created = await firstManager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await firstManager.send(scope, created.id, 'pause');
      const run = firstWorker.last('run');
      const correlation = providerCorrelation(run, 'aborted');
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation, phase: 'started', index: 1,
      });
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'assistant-text-delta', correlation, delta: 'visible partial',
      });
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        correlation,
        message: {
          role: 'assistant', content: [{ type: 'text', text: 'visible partial' }], stopReason: 'aborted',
        },
      });
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation, phase: 'aborted', index: 1,
      });
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'state', correlation: run.correlation, state: 'interrupted',
      });
      await vi.waitFor(async () => {
        expect((await firstManager.list(scope)).sessions[0]?.turns[0]?.cards[0]).toMatchObject({
          content: 'visible partial', state: 'stopped', excludedFromContext: true,
        });
      });
      await firstManager.shutdown();

      const secondWorker = new FakeWorker();
      secondManager = new IrisAgentSessionManager(userData, projectManager(), {
        workerFactory: () => secondWorker,
        modelCatalogLoader: async () => catalog,
      });
      const restored = (await secondManager.list(scope)).sessions[0]!;
      await secondManager.retry(scope, restored.id, { expectedRevision: restored.revision });
      expect(secondWorker.last('initialize').history.messages.filter((message) => message.role === 'user')).toEqual([
        expect.objectContaining({ content: expect.stringContaining('<user-request>\npause\n</user-request>') }),
      ]);
      expect(secondWorker.last('initialize').history.messages.some(
        (message) => message.role === 'assistant' && message.content.includes('visible partial'),
      )).toBe(false);
    } finally {
      await firstManager.shutdown();
      await secondManager?.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it(
    'reveals and supervises one interactive PTY without timing it out',
    async () => {
      const userData = await createTempDataDir('iris-agent-manager-terminal-');
      const scope: ProjectScope = { root: userData, generation: 1 };
      const worker = new FakeWorker();
      const outputEvents: Array<{ terminalId: string; cursor: number }> = [];
      const manager = new IrisAgentSessionManager(userData, projectManager(), {
        workerFactory: () => worker,
        modelCatalogLoader: async () => catalog,
        terminalFactory: (options) => new FakeInteractiveTerminal(options) as unknown as AgentCommandPty,
        terminalDisplayThresholdMs: 20,
        supervisionIntervalMs: 30,
      });
      manager.on('terminalOutput', (event: { terminalId: string; cursor: number }) => {
        outputEvents.push(event);
      });
      try {
        await manager.listModels();
        const created = await manager.createSession({
          scope,
          anchor: { kind: 'workspace', path: '.iris' },
        });
        await manager.send(scope, created.id, 'run an interactive command');
        const run = worker.last('run');
        const provider = providerCorrelation(run, 'interactive-terminal');
        worker.emitMessage({
          version: IRIS_AGENT_PROTOCOL_VERSION,
          type: 'provider-attempt',
          correlation: provider,
          phase: 'started',
          index: 1,
        });
        worker.emitMessage({
          version: IRIS_AGENT_PROTOCOL_VERSION,
          type: 'provider-message',
          eventId: 'event-interactive-terminal',
          correlation: provider,
          message: {
            role: 'assistant',
            content: [{
              type: 'toolCall',
              id: 'tool-terminal',
              name: 'terminal',
              arguments: { command: 'interactive' },
            }],
            stopReason: 'toolUse',
          },
        });
        await vi.waitFor(() => expect(worker.messages).toContainEqual(expect.objectContaining({
          type: 'event-ack',
          eventId: 'event-interactive-terminal',
          ok: true,
        })));
        const command = [
          "[Console]::Write('first')",
          '$one = [Console]::ReadLine()',
          "[Console]::Write('second:' + $one)",
          '$two = [Console]::ReadLine()',
          "[Console]::Write('done:' + $two)",
        ].join('; ');
        worker.emitMessage({
          version: IRIS_AGENT_PROTOCOL_VERSION,
          type: 'tool-request',
          correlation: {
            ...run.correlation,
            toolCallId: 'tool-terminal',
            operationId: 'operation-terminal',
          },
          input: {
            tool: 'terminal',
            operation: 'exec',
            command,
            intent: 'operation',
            cwd: userData,
          },
        });

        await vi.waitFor(async () => {
          const terminal = (await manager.list(scope)).sessions[0]?.terminals[0];
          expect(terminal).toMatchObject({ state: 'running', command, userInput: false });
        }, { timeout: 5_000 });
        const running = (await manager.list(scope)).sessions[0]!.terminals[0]!;
        const replay = await manager.replayTerminal(scope, created.id, running.id, 80, 24);
        expect(Buffer.from(replay.data, 'base64').toString('utf8')).toContain('first');
        expect(outputEvents.some((event) => event.terminalId === running.id)).toBe(true);
        expect(worker.messages.some((message) => message.type === 'tool-result')).toBe(false);

        await vi.waitFor(() => expect(
          worker.messages.filter((message) => message.type === 'supervise-terminal'),
        ).toHaveLength(1), { timeout: 5_000 });
        const firstSupervision = worker.last('supervise-terminal');
        expect(firstSupervision.input.incrementalOutput).toContain('first');
        worker.emitMessage({
          version: IRIS_AGENT_PROTOCOL_VERSION,
          type: 'terminal-supervision-result',
          correlation: firstSupervision.correlation,
          supervisionId: firstSupervision.supervisionId,
          result: { outcome: 'normal' },
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(worker.messages.filter((message) => message.type === 'supervise-terminal')).toHaveLength(1);

        await manager.writeTerminal(scope, created.id, running.id, 'one\r');
        await vi.waitFor(() => expect(
          worker.messages.filter((message) => message.type === 'supervise-terminal'),
        ).toHaveLength(2), { timeout: 5_000 });
        const secondSupervision = worker.last('supervise-terminal');
        expect(secondSupervision.input.incrementalOutput).toContain('second:one');
        worker.emitMessage({
          version: IRIS_AGENT_PROTOCOL_VERSION,
          type: 'terminal-supervision-result',
          correlation: secondSupervision.correlation,
          supervisionId: secondSupervision.supervisionId,
          result: { outcome: 'suspicious', evidence: 'unexpected repeated prompt' },
        });
        await vi.waitFor(async () => {
          const projected = (await manager.list(scope)).sessions[0]!;
          expect(projected.supervisionAlert).toMatchObject({
            terminalId: running.id,
            evidence: 'unexpected repeated prompt',
          });
          expect(projected.terminals[0]?.state).toBe('running');
        });
        expect(worker.messages.some((message) => message.type === 'tool-result')).toBe(false);
        const persistedWhileWaiting = (await IrisAgentSessionStore.load({
          userDataPath: userData,
          projectRoot: scope.root,
        })).get(created.id)!;
        expect(persistedWhileWaiting.transcript.map((frame) => frame.role)).toEqual([
          'user', 'assistant',
        ]);

        await manager.continueTerminalSupervision(scope, created.id, running.id);
        expect((await manager.list(scope)).sessions[0]?.supervisionAlert).toBeUndefined();
        await manager.writeTerminal(scope, created.id, running.id, 'two\r');
        await vi.waitFor(() => expect(worker.last('tool-result')).toMatchObject({
          ok: true,
          result: { kind: 'terminal', exitCode: 0, terminalId: running.id },
        }), { timeout: 5_000 });
        await vi.waitFor(async () => {
          expect((await manager.list(scope)).sessions[0]?.terminals[0]).toMatchObject({
            id: running.id,
            state: 'exited',
            outcome: 'success',
            userInput: true,
          });
        });
        await expect(
          manager.writeTerminal(scope, created.id, running.id, 'late\r'),
        ).rejects.toThrow('no longer running');
      } finally {
        await manager.shutdown();
        await removeTempDataDir(userData);
      }
    },
    15_000,
  );
});

describe('Iris Agent model catalog startup', () => {
  it('creates a session without starting model discovery', async () => {
    const userData = await createTempDataDir('iris-agent-manager-open-fast-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const loader = vi.fn(async () => catalog);
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      modelCatalogLoader: loader,
    });
    try {
      const created = await manager.createSession({
        scope,
        anchor: { kind: 'workspace', path: '.iris' },
      });
      expect(created.model).toBeNull();
      expect(loader).not.toHaveBeenCalled();
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('shares concurrent discovery and only reloads after an explicit refresh', async () => {
    const userData = await createTempDataDir('iris-agent-manager-model-cache-');
    let resolveFirst!: (value: IrisAgentModelCatalog) => void;
    const firstLoad = new Promise<IrisAgentModelCatalog>((resolve) => { resolveFirst = resolve; });
    const loader = vi.fn()
      .mockImplementationOnce(() => firstLoad)
      .mockResolvedValue(catalog);
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      modelCatalogLoader: loader,
    });
    try {
      const first = manager.listModels();
      const second = manager.listModels();
      expect(loader).toHaveBeenCalledOnce();
      resolveFirst(catalog);
      await expect(Promise.all([first, second])).resolves.toEqual([catalog, catalog]);

      await expect(manager.listModels()).resolves.toEqual(catalog);
      expect(loader).toHaveBeenCalledOnce();
      await expect(manager.listModels(true)).resolves.toEqual(catalog);
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });
});

describe('Iris Agent remembered default model', () => {
  const multiModelCatalog: IrisAgentModelCatalog = {
    models: [
      {
        provider: 'openai', modelId: 'gpt-test', name: 'GPT Test',
        api: 'openai-responses', reasoning: true,
      },
      {
        provider: 'anthropic', modelId: 'claude-test', name: 'Claude Test',
        api: 'anthropic-messages', reasoning: false,
      },
    ],
  };

  function settingsManager(root: string): SettingsManager {
    return new SettingsManager(new JsonStore(join(root, 'settings.json'), 0));
  }

  it('uses the remembered default model for new sessions', async () => {
    const userData = await createTempDataDir('iris-agent-manager-default-model-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const settings = settingsManager(userData);
    settings.update({
      experimental: { irisAgentDefaultModel: { provider: 'anthropic', modelId: 'claude-test' } },
    });
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      settingsManager: settings,
      modelCatalogLoader: async () => multiModelCatalog,
    });
    try {
      const created = await manager.createSession({
        scope,
        anchor: { kind: 'document', path: '.iris/issue/task.md' },
      });
      expect(created.model).toEqual({ provider: 'anthropic', modelId: 'claude-test' });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('remembers the model chosen via setModel for later sessions', async () => {
    const userData = await createTempDataDir('iris-agent-manager-set-model-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const settings = settingsManager(userData);
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      settingsManager: settings,
      modelCatalogLoader: async () => multiModelCatalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({
        scope,
        anchor: { kind: 'document', path: '.iris/issue/task.md' },
      });
      expect(created.model).toEqual({ provider: 'openai', modelId: 'gpt-test' });
      await manager.setModel(
        scope,
        created.id,
        { provider: 'anthropic', modelId: 'claude-test' },
        { expectedRevision: created.revision },
      );
      expect(settings.get().experimental.irisAgentDefaultModel).toEqual({
        provider: 'anthropic', modelId: 'claude-test',
      });
      const second = await manager.createSession({
        scope,
        anchor: { kind: 'document', path: '.iris/issue/other.md' },
      });
      expect(second.model).toEqual({ provider: 'anthropic', modelId: 'claude-test' });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('falls back to the first catalog model when the remembered default is unavailable', async () => {
    const userData = await createTempDataDir('iris-agent-manager-stale-model-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const settings = settingsManager(userData);
    settings.update({
      experimental: { irisAgentDefaultModel: { provider: 'stale', modelId: 'gone' } },
    });
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      settingsManager: settings,
      modelCatalogLoader: async () => multiModelCatalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({
        scope,
        anchor: { kind: 'workspace', path: '.iris' },
      });
      expect(created.model).toEqual({ provider: 'openai', modelId: 'gpt-test' });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });
});

describe('Iris Agent system proxy rules', () => {
  it('uses the first supported Electron proxy decision in order', () => {
    expect(parseElectronProxyRules('PROXY 127.0.0.1:7890; DIRECT')).toEqual({
      mode: 'proxy', url: 'http://127.0.0.1:7890/',
    });
    expect(parseElectronProxyRules('DIRECT; PROXY 127.0.0.1:7890')).toEqual({ mode: 'direct' });
    expect(() => parseElectronProxyRules('SOCKS5 127.0.0.1:1080')).toThrow(/SOCKS/);
  });
});
