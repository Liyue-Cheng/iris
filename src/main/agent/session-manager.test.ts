import { EventEmitter } from 'node:events';
import { access, readFile } from 'node:fs/promises';
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
import {
  IrisAgentSessionManager,
  parseElectronProxyRules,
  type IrisAgentSessionManagerOptions,
} from './session-manager';
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
        executorVersion: 'test',
        nodeVersion: process.versions.node,
        workerEpoch: message.correlation.workerEpoch ?? 0,
        historyRevision: message.history.revision,
        historyMessageCount: message.history.messages.length,
        historyDigest: agentHistoryDigest(message.history),
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
    invokeId: `call-${suffix}`,
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
  it('starts a document session with the default task when the input is empty', async () => {
    const userData = await createTempDataDir('iris-agent-manager-default-document-task-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({
        scope,
        anchor: { kind: 'document', path: '.iris/issue/task.md' },
      });
      await manager.send(scope, created.id, '   ');
      const current = (await manager.list(scope)).sessions[0]!;
      expect(current.intents[0]?.user.content).toBe('请根据文档内容开始工作');
      expect(worker.last('run').prompt).toContain('<user-request>\n请根据文档内容开始工作\n</user-request>');
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('still requires an explicit task for a workspace session with empty input', async () => {
    const userData = await createTempDataDir('iris-agent-manager-empty-workspace-task-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({
        scope,
        anchor: { kind: 'workspace', path: '.iris' },
      });
      await expect(manager.send(scope, created.id, '')).rejects.toThrow('Enter a task');
      expect((await manager.list(scope)).sessions[0]?.intents).toHaveLength(0);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

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
        expect(projected.intents[0]?.user.content).toBe('visible immediately');
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
        expect((await manager.list(scope)).sessions[0]?.intents[0]?.cards[0]).toMatchObject({
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
          content: 'do work',
        }),
      ]);
      const resume = resumedWorker.last('resume');
      expect(resume.correlation.intentId).toBe(run.correlation.intentId);
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
        const cards = (await manager.list(scope)).sessions[0]?.intents[0]?.cards;
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

  it('keeps a superseded Intent in history when a new input takes over after Stop', async () => {
    const userData = await createTempDataDir('iris-agent-manager-superseded-history-');
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
        anchor: { kind: 'workspace', path: '.iris' },
      });
      await manager.send(scope, created.id, 'first input');
      const beforeStop = (await manager.list(scope)).sessions[0]!;
      await manager.stop(scope, created.id, { expectedRevision: beforeStop.revision });
      const paused = (await manager.list(scope)).sessions[0]!;

      await manager.send(scope, created.id, 'replacement input', { expectedRevision: paused.revision });
      const current = (await manager.list(scope)).sessions[0]!;
      expect(current.intents.map((intent) => [intent.user.content, intent.state])).toEqual([
        ['first input', 'superseded'],
        ['replacement input', 'running'],
      ]);
      expect(current.intents[0]?.canForkFromInput).toBe(true);
      expect(current.currentIntentId).toBe(current.intents[1]?.id);
      expect(workers[1]!.last('run').history.messages.map((message) => message.content)).toContain('first input');
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
        expect(projected.intents[0]?.cards).toEqual([]);
      });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('continues the same paused Intent with the newly selected Provider model', async () => {
    const userData = await createTempDataDir('iris-agent-manager-switch-model-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const workers: FakeWorker[] = [];
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      modelCatalogLoader: async () => ({
        models: [
          ...catalog.models,
          {
            provider: 'anthropic', modelId: 'claude-test', name: 'Claude Test',
            api: 'anthropic-messages', reasoning: false,
          },
        ],
      }),
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, 'recover across providers');
      const firstWorker = workers[0]!;
      const firstRun = firstWorker.last('run');
      expect(firstRun.runtime.model).toEqual({ provider: 'openai', modelId: 'gpt-test' });

      const failed = providerCorrelation(firstRun, 'unavailable');
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt',
        correlation: failed,
        phase: 'started',
        index: 1,
      });
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt',
        correlation: failed,
        phase: 'failed',
        index: 1,
        error: 'provider unavailable',
      });
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'execution-paused',
        correlation: failed,
        reason: 'provider-exhausted',
        message: 'provider unavailable',
      });
      await vi.waitFor(async () => {
        expect((await manager.list(scope)).sessions[0]?.pause?.reason).toBe('provider');
      });

      const held = (await IrisAgentSessionStore.load({
        userDataPath: userData,
        projectRoot: scope.root,
      })).get(created.id)!;
      expect(held.invokes[0]).toMatchObject({ state: 'holding' });
      expect(held.invokeAttempts[0]).toMatchObject({ state: 'failed' });

      const paused = (await manager.list(scope)).sessions[0]!;
      const switched = await manager.setModel(
        scope,
        created.id,
        { provider: 'anthropic', modelId: 'claude-test' },
        { expectedRevision: paused.revision },
      );
      await manager.retry(scope, created.id, { expectedRevision: switched.revision });

      const resumed = workers[1]!.last('resume');
      expect(resumed.correlation.intentId).toBe(firstRun.correlation.intentId);
      expect(resumed.invokeId).toBe(held.invokes[0]?.id);
      expect(resumed.runtime.model).toEqual({ provider: 'anthropic', modelId: 'claude-test' });
      expect(resumed.history.messages).toContainEqual(expect.objectContaining({
        role: 'user', content: 'recover across providers',
      }));
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('reuses an idle Worker while each Send resolves the latest Session model', async () => {
    const userData = await createTempDataDir('iris-agent-manager-reuse-switch-model-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const workers: FakeWorker[] = [];
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      modelCatalogLoader: async () => ({
        models: [
          ...catalog.models,
          {
            provider: 'anthropic', modelId: 'claude-test', name: 'Claude Test',
            api: 'anthropic-messages', reasoning: false,
          },
        ],
      }),
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, 'first message');
      const worker = workers[0]!;
      const firstRun = worker.last('run');
      const first = providerCorrelation(firstRun, 'first-model');
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: first, phase: 'started', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        correlation: first,
        message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }], stopReason: 'stop' },
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: first, phase: 'completed', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'execution-settled', correlation: firstRun.correlation,
      });
      await vi.waitFor(async () => {
        expect((await manager.list(scope)).sessions[0]?.state).toBe('idle');
      });

      const idle = (await manager.list(scope)).sessions[0]!;
      const switched = await manager.setModel(
        scope,
        created.id,
        { provider: 'anthropic', modelId: 'claude-test' },
        { expectedRevision: idle.revision },
      );
      expect(worker.terminate).not.toHaveBeenCalled();

      await manager.send(scope, created.id, 'second message', { expectedRevision: switched.revision });
      expect(workers).toHaveLength(1);
      const secondRun = worker.last('run');
      expect(secondRun.runtime.model).toEqual({ provider: 'anthropic', modelId: 'claude-test' });
      expect(secondRun.history.messages.map((message) => message.content)).toEqual([
        'first message', 'first answer',
      ]);
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
      const intentId = run.correlation.intentId;
      expect(intentId).toBeDefined();
      if (!intentId) throw new Error('Run request is missing intentId');
      emitReply(worker, run, 'race', 'kept before stop');

      await manager.stop(scope, created.id, {
        expectedRevision: created.revision,
        expectedIntentId: intentId,
      });
      expect(worker.terminate).toHaveBeenCalledOnce();

      await vi.waitFor(async () => {
        const projected = (await manager.list(scope)).sessions[0]!;
        expect(projected.pause?.reason).toBe('user');
        expect(projected.intents[0]?.cards).toEqual([
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
        expect((await manager.list(scope)).sessions[0]?.intents[0]?.cards[0]?.state).toBe('stopped');
      });

      const paused = (await manager.list(scope)).sessions[0]!;
      await manager.retry(scope, created.id, { expectedRevision: paused.revision });
      const resumedWorker = workers[1]!;
      expect(resumedWorker.last('initialize').history.messages.at(-1)).toMatchObject({
        role: 'tool',
        toolCallId: 'tool-1',
        tool: 'read',
        isError: true,
      });
      expect(resumedWorker.last('resume').correlation.intentId).toBe(run.correlation.intentId);

      settleTool({
        result: { kind: 'file', contentBase64: '' },
        update: { state: 'completed', completedAt: Date.now(), resultSummary: '0 bytes', path: 'README.md' },

      });
      await vi.waitFor(async () => {
        const card = (await manager.list(scope)).sessions[0]?.intents[0]?.cards[0];
        expect(card).toMatchObject({ state: 'stopped' });
        expect(card?.kind === 'local-retrieval' ? card.items[0]?.detail : undefined).toBeUndefined();
      });
      expect(resumedWorker.messages.some((message) => message.type === 'tool-result')).toBe(false);
      const persisted = (await IrisAgentSessionStore.load({
        userDataPath: userData,
        projectRoot: scope.root,
      })).get(created.id)!;
      expect(persisted.toolOperations[0]).toMatchObject({ state: 'failed', error: 'Paused by user.' });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('commits Invoke -> ToolCall -> ToolResult before continuing to the final Invoke', async () => {
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
        invokeId: 'call-final',
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
        expect(projected.intents[0]?.state).toBe('completed');
      });
      const persisted = (await IrisAgentSessionStore.load({
        userDataPath: userData,
        projectRoot: scope.root,
      })).get(created.id)!;
      expect(persisted.invokes.map((call) => call.id)).toEqual(['call-tool-parent', 'call-final']);
      expect(persisted.turns).toHaveLength(2);
      expect(persisted.turns[0]?.assistant?.toolCalls).toEqual([
        expect.objectContaining({ id: 'tool-1', tool: 'read' }),
      ]);
      expect(persisted.turns[0]?.toolResults).toEqual([
        expect.objectContaining({ toolCallId: 'tool-1', isError: false }),
      ]);
      expect(persisted.turns[1]?.assistant?.content).toBe('Done.');
      expect(persisted.timeline.find((activity) => activity.kind === 'tool')).toMatchObject({
        invokeId: 'call-tool-parent', toolCallId: 'tool-1', state: 'completed',
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
      if (source.intents.some((turn) => turn.state === 'paused')) {
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
        expect(projected.intents[0]).toMatchObject({ state: 'completed' });
        expect(projected.intents[0]?.cards[0]).toMatchObject({
          content: 'Committed answer.', state: 'completed',
        });
      });
      expect(worker.terminate).toHaveBeenCalledOnce();
      const persisted = (await IrisAgentSessionStore.load({
        userDataPath: userData,
        projectRoot: scope.root,
      })).get(created.id)!;
      expect(persisted.invokes[0]).toMatchObject({ state: 'completed' });
      expect(persisted.invokeAttempts[0]).toMatchObject({ state: 'completed' });
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
          toolCalls: [expect.objectContaining({ id: 'tool-before-request', tool: 'read' })],
        },
        {
          role: 'tool',
          toolCallId: 'tool-before-request',
          tool: 'read',
          isError: true,
        },
      ]);
      expect(resumedWorker.last('resume').correlation.intentId).toBe(run.correlation.intentId);
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
        expect((await firstManager.list(scope)).sessions[0]?.intents[0]?.cards[0]).toMatchObject({
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
        expect.objectContaining({ content: 'pause' }),
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

  it('starts an input branch without replacing its Intent identity', async () => {
    const userData = await createTempDataDir('iris-agent-manager-input-branch-');
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
        anchor: { kind: 'workspace', path: '.iris' },
      });
      await manager.send(scope, created.id, 'branch input');
      const sourceRun = workers[0]!.last('run');
      const intentId = sourceRun.correlation.intentId!;
      await manager.stop(scope, created.id);
      const source = (await manager.list(scope)).sessions.find((session) => session.id === created.id)!;
      const artifactStore = await IrisAgentSessionStore.load({
        userDataPath: userData,
        projectRoot: scope.root,
      });
      expect(await readFile(artifactStore.promptSnapshotPath(source.id, intentId), 'utf8'))
        .toContain('branch input');
      const branch = await manager.branchFromInput(scope, created.id, intentId, {
        expectedRevision: source.revision,
      });
      await expect(access(artifactStore.promptSnapshotPath(branch.id, intentId)))
        .rejects.toMatchObject({ code: 'ENOENT' });

      await manager.retry(scope, branch.id, { expectedRevision: branch.revision });
      expect(await readFile(artifactStore.promptSnapshotPath(branch.id, intentId), 'utf8'))
        .toContain('branch input');
      const branchWorker = workers[1]!;
      expect(branchWorker.last('initialize').history.messages).toEqual([]);
      expect(branchWorker.last('run').correlation.intentId).toBe(intentId);
      const runningBranch = (await manager.list(scope)).sessions.find((session) => session.id === branch.id)!;
      expect(runningBranch).toMatchObject({ state: 'running', currentIntentId: intentId });
      expect(runningBranch.intents).toHaveLength(1);
      await manager.stop(scope, branch.id);
      const persisted = (await IrisAgentSessionStore.load({
        userDataPath: userData,
        projectRoot: scope.root,
      })).get(branch.id)!;
      expect(persisted.intents).toHaveLength(1);
      expect(persisted.intents[0]).toMatchObject({ id: intentId, state: 'paused' });
      expect(persisted.activeIntentIds).toEqual([intentId]);
    } finally {
      await manager.shutdown();
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
            timeout: 30,
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
        expect(persistedWhileWaiting.turns[0]?.assistant?.toolCalls).toHaveLength(1);
        expect(persistedWhileWaiting.turns[0]?.toolResults).toEqual([]);

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
      expect(loader).toHaveBeenNthCalledWith(1, false);
      resolveFirst(catalog);
      await expect(Promise.all([first, second])).resolves.toEqual([catalog, catalog]);

      await expect(manager.listModels()).resolves.toEqual(catalog);
      expect(loader).toHaveBeenCalledOnce();
      await expect(manager.listModels(true)).resolves.toEqual(catalog);
      expect(loader).toHaveBeenCalledTimes(2);
      expect(loader).toHaveBeenNthCalledWith(2, true);
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

describe('IrisAgentSessionManager context compaction', () => {
  /**
   * Test messages are short, so the trigger has to sit low enough that two
   * settled Intents already crowd the window.
   */
  const compactionThresholds = { contextWindow: 70, reserveTokens: 50, keepRecentTokens: 20 };

  type SummarizeContext = NonNullable<IrisAgentSessionManagerOptions['summarizeContext']>;

  function summarizer(text: string) {
    return vi.fn<Parameters<SummarizeContext>, ReturnType<SummarizeContext>>(async () => text);
  }

  /** Runs one Intent to completion so the Session accumulates settled history. */
  async function settleIntent(
    manager: IrisAgentSessionManager,
    worker: FakeWorker,
    scope: ProjectScope,
    sessionId: string,
    message: string,
    answer: string,
  ): Promise<void> {
    const current = (await manager.list(scope)).sessions.find((session) => session.id === sessionId)!;
    await manager.send(scope, sessionId, message, { expectedRevision: current.revision });
    const run = worker.last('run');
    const correlation = providerCorrelation(run, message);
    worker.emitMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'provider-attempt', correlation, phase: 'started', index: 1,
    });
    worker.emitMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'provider-message',
      correlation,
      message: { role: 'assistant', content: [{ type: 'text', text: answer }], stopReason: 'stop' },
    });
    worker.emitMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'provider-attempt', correlation, phase: 'completed', index: 1,
    });
    worker.emitMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'execution-settled', correlation: run.correlation,
    });
    await vi.waitFor(async () => {
      const settled = (await manager.list(scope)).sessions.find((session) => session.id === sessionId)!;
      // Surface why a run stalled instead of only reporting the wrong state.
      expect(settled.pause?.message ?? settled.state).toBe('idle');
    });
  }

  it('folds summarized history out of the next request while keeping the recent tail', async () => {
    const userData = await createTempDataDir('iris-agent-compact-threshold-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const summarize = summarizer('Earlier: implemented the parser.');
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      summarizeContext: summarize,
      compactionThresholds,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await settleIntent(manager, worker, scope, created.id, 'first message', 'first answer');
      await settleIntent(manager, worker, scope, created.id, 'second message', 'second answer');
      await settleIntent(manager, worker, scope, created.id, 'third message', 'third answer');

      expect(summarize).toHaveBeenCalled();
      // Only settled history is summarized, never the live method layers.
      const { material } = summarize.mock.calls[0]![0];
      expect(material).toContain('first message');
      expect(material).not.toContain('<iris-software>');

      const contents = worker.last('run').history.messages.map((message) => message.content);
      expect(contents.some((content) => content.includes('Earlier: implemented the parser.'))).toBe(true);
      expect(contents).not.toContain('first message');
      // The most recent exchange still reaches the provider verbatim.
      expect(contents).toContain('second answer');
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('keeps the full Trace on disk after Context folds', async () => {
    const userData = await createTempDataDir('iris-agent-compact-trace-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      summarizeContext: async () => 'folded summary',
      compactionThresholds,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await settleIntent(manager, worker, scope, created.id, 'first message', 'first answer');
      await settleIntent(manager, worker, scope, created.id, 'second message', 'second answer');
      await settleIntent(manager, worker, scope, created.id, 'third message', 'third answer');

      const session = (await manager.list(scope)).sessions.find((candidate) => candidate.id === created.id)!;
      // Compaction changes what is sent, never what happened.
      expect(session.intents.map((intent) => intent.user.content)).toEqual([
        'first message', 'second message', 'third message',
      ]);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('sends the request uncompacted when summarizing fails', async () => {
    const userData = await createTempDataDir('iris-agent-compact-failure-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      summarizeContext: async () => { throw new Error('provider refused'); },
      compactionThresholds,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await settleIntent(manager, worker, scope, created.id, 'first message', 'first answer');
      await settleIntent(manager, worker, scope, created.id, 'second message', 'second answer');
      // A failed tidy-up must not block the user's request.
      await settleIntent(manager, worker, scope, created.id, 'third message', 'third answer');

      const contents = worker.last('run').history.messages.map((message) => message.content);
      expect(contents).toContain('first message');
      expect(contents.some((content) => content.includes('<history-summary>'))).toBe(false);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('rejects a manual compaction when no runtime summarizer is available', async () => {
    const userData = await createTempDataDir('iris-agent-compact-unavailable-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await settleIntent(manager, worker, scope, created.id, 'first message', 'first answer');
      await expect(manager.compact(scope, created.id)).rejects.toThrow(/unavailable/iu);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('reuses one summary across later requests instead of regenerating it', async () => {
    const userData = await createTempDataDir('iris-agent-compact-reuse-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const summarize = summarizer('stable summary');
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      summarizeContext: summarize,
      compactionThresholds,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await settleIntent(manager, worker, scope, created.id, 'first message', 'first answer');
      await settleIntent(manager, worker, scope, created.id, 'second message', 'second answer');
      await settleIntent(manager, worker, scope, created.id, 'third message', 'third answer');
      const afterFirst = summarize.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);
      await settleIntent(manager, worker, scope, created.id, 'fourth message', 'fourth answer');
      // The persisted contract is reused; a new summary is only paid for when the
      // boundary actually advances.
      expect(summarize.mock.calls.length).toBeLessThanOrEqual(afterFirst + 1);
      const contents = worker.last('run').history.messages.map((message) => message.content);
      expect(contents.some((content) => content.includes('stable summary'))).toBe(true);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('compacts and retries the same Intent once after a context overflow', async () => {
    const userData = await createTempDataDir('iris-agent-compact-overflow-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const firstWorker = new FakeWorker();
    const retryWorker = new FakeWorker();
    let workerCount = 0;
    const summarize = summarizer('overflow summary');
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => (++workerCount === 1 ? firstWorker : retryWorker),
      modelCatalogLoader: async () => catalog,
      summarizeContext: summarize,
      compactionThresholds: { contextWindow: 100_000, reserveTokens: 1_000, keepRecentTokens: 1 },
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await settleIntent(manager, firstWorker, scope, created.id, 'first message', 'first answer');
      await settleIntent(manager, firstWorker, scope, created.id, 'second message', 'second answer');
      const before = (await manager.list(scope)).sessions[0]!;
      const started = await manager.send(scope, created.id, 'third message', { expectedRevision: before.revision });
      const intentId = started.currentIntentId;
      const failedRun = firstWorker.last('run');
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'execution-paused',
        correlation: failedRun.correlation,
        reason: 'runtime-error',
        message: 'maximum context length exceeded',
      });
      await vi.waitFor(() => expect(retryWorker.last('run').prompt).toContain('third message'));
      const afterRetry = (await manager.list(scope)).sessions[0]!;
      expect(afterRetry.currentIntentId).toBe(intentId);
      expect(afterRetry.state).toBe('running');
      expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ material: expect.any(String) }));
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
