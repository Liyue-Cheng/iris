import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_ATTACHMENT_MAX_COUNT,
  AGENT_IMAGE_MAX_BYTES,
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
import { IrisAgentSessionStore, agentSessionStorePath } from './session-store';
const catalog: IrisAgentModelCatalog = {
  models: [{
    provider: 'openai', modelId: 'gpt-test', name: 'GPT Test',
    api: 'openai-responses', reasoning: true,
    reasoningLevel: 'off', supportedReasoningLevels: ['off'],
    capabilities: { input: ['text', 'image'] },
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
  /** Flow blockers reported by the session manager, in order. */
  readonly flowBlocked: boolean[] = [];
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

  setOutputBlocked(_blocker: 'renderer', blocked: boolean): void {
    this.flowBlocked.push(blocked);
  }

  async replay(): Promise<{ data: string }> {
    return { data: Buffer.from(this.text).toString('base64') };
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
      bytes: Buffer.from(value),
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

/** A PNG header plus padding, matching what the tool host would classify. */
function pngFixture(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(777)]);
}

/**
 * Drives one already-posted run to a completed Intent, without sending a new
 * message. Used where the request under test was created with attachments.
 */
async function settleRun(
  manager: IrisAgentSessionManager,
  worker: FakeWorker,
  scope: ProjectScope,
  sessionId: string,
  run: Extract<AgentWorkerRequest, { type: 'run' }>,
  answer: string,
): Promise<void> {
  const correlation = providerCorrelation(run, answer);
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
    expect(settled.pause?.message ?? settled.state).toBe('idle');
  });
}

function projectManager(): ProjectManager {
  return {
    softwarePromptState: vi.fn(async () => ({
      project: { text: '', source: 'default', configured: false, error: null },
    })),
    readDoc: vi.fn(async (path: string) => ({ path, raw: '# Focus' })),
  } as unknown as ProjectManager;
}

/**
 * The readable half of a history message. History content is a string for most
 * messages and text-plus-images for a tool result that read a picture, so tests
 * that assert on what the model was told read through this.
 */
function historyText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) =>
    part && typeof part === 'object' && (part as { type?: string }).type === 'text'
      ? [(part as { text: string }).text]
      : []).join('\n');
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
      expect(workers[1]!.last('run').history.messages.map((message) => historyText(message.content))).toContain('first input');
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
            reasoningLevel: 'off', supportedReasoningLevels: ['off'],
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
            reasoningLevel: 'off', supportedReasoningLevels: ['off'],
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
      expect(secondRun.history.messages.map((message) => historyText(message.content))).toEqual([
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

  it('snapshots an image read, replays it into later history, and serves it to the renderer', async () => {
    const userData = await createTempDataDir('iris-agent-manager-image-read-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const png = pngFixture(8, 6);
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      toolExecutor: async () => ({
        result: {
          kind: 'image',
          mimeType: 'image/png',
          contentBase64: png.toString('base64'),
          bytes: png.byteLength,
          width: 8,
          height: 6,
        },
        update: {
          state: 'completed', completedAt: Date.now(),
          resultSummary: 'image/png 8x6 801 B', path: 'assets/shot.png',
        },
      }),
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, 'look at the screenshot');
      const run = worker.last('run');
      const first = providerCorrelation(run, 'image-parent');
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: first, phase: 'started', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        eventId: 'event-image-tool-call',
        correlation: first,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Opening it.' },
            { type: 'toolCall', id: 'tool-image', name: 'read', arguments: { path: 'assets/shot.png' } },
          ],
          stopReason: 'toolUse',
        },
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: first, phase: 'completed', index: 1,
      });
      await vi.waitFor(() => expect(worker.messages).toContainEqual(expect.objectContaining({
        type: 'event-ack', eventId: 'event-image-tool-call', ok: true,
      })));
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'tool-request',
        correlation: { ...run.correlation, toolCallId: 'tool-image', operationId: 'operation-image' },
        input: { tool: 'read', operation: 'readFile', absolutePath: 'assets/shot.png' },
      });
      await vi.waitFor(() => expect(worker.last('tool-result')).toMatchObject({
        correlation: { toolCallId: 'tool-image', operationId: 'operation-image' },
        ok: true,
        result: { kind: 'image', mimeType: 'image/png', width: 8, height: 6 },
      }));

      // The read is only useful if the card can show it and the Trace can name it.
      const afterRead = (await manager.list(scope)).sessions[0]!;
      const retrieval = afterRead.intents[0]!.cards
        .flatMap((card) => (card.kind === 'local-retrieval' ? card.items : []))
        .find((item) => item.kind === 'file')!;
      const attachment = retrieval.image!;
      expect(attachment).toMatchObject({
        name: 'shot.png', mimeType: 'image/png', bytes: png.byteLength, width: 8, height: 6,
      });
      expect(retrieval.label).toBe('assets/shot.png');

      const data = await manager.readAttachmentData(scope, created.id, attachment.id);
      expect(data).toEqual({
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        error: null,
      });
      await expect(manager.readAttachmentData(scope, created.id, 'f'.repeat(64)))
        .resolves.toEqual({ dataUrl: null, error: 'not-found' });

      // A re-delivered tool request must return the same image, which is what
      // makes the reduced journal record lossless rather than merely smaller.
      worker.messages.length = 0;
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'tool-request',
        correlation: { ...run.correlation, toolCallId: 'tool-image', operationId: 'operation-image' },
        input: { tool: 'read', operation: 'readFile', absolutePath: 'assets/shot.png' },
      });
      await vi.waitFor(() => expect(worker.last('tool-result')).toMatchObject({
        correlation: { toolCallId: 'tool-image', operationId: 'operation-image' },
        ok: true,
        result: { kind: 'image', contentBase64: png.toString('base64') },
      }));

      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        eventId: 'event-image-tool-result',
        correlation: {
          ...run.correlation, toolCallId: 'tool-image', providerMessageId: 'message-image-tool-result',
        },
        message: {
          role: 'toolResult',
          toolCallId: 'tool-image',
          isError: false,
          content: [
            { type: 'text', text: 'assets/shot.png: image image/png 8x6 (801 B).' },
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          ],
        },
      });
      await vi.waitFor(() => expect(worker.messages).toContainEqual(expect.objectContaining({
        type: 'event-ack', eventId: 'event-image-tool-result', ok: true,
      })));

      const second = {
        ...run.correlation, invokeId: 'call-image-final', attemptId: 'attempt-image-final',
        providerMessageId: 'message-image-final',
      };
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: second, phase: 'started', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message', correlation: second,
        message: { role: 'assistant', content: [{ type: 'text', text: 'It is a small image.' }], stopReason: 'stop' },
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
      });

      const persisted = (await IrisAgentSessionStore.load({
        userDataPath: userData, projectRoot: scope.root,
      })).get(created.id)!;
      // The Turn records the reference; the bytes stay in the attachment store.
      expect(persisted.turns[0]!.toolResults[0]!.attachments).toEqual([attachment]);
      expect(JSON.stringify(persisted)).not.toContain(png.toString('base64'));
      // The operation keeps enough to replay itself, and no more.
      expect(persisted.toolOperations[0]!.result).toEqual({
        kind: 'image',
        attachmentId: attachment.id,
        mimeType: 'image/png',
        bytes: png.byteLength,
        width: 8,
        height: 6,
      });

      // A follow-up request re-sends the same pixels, not a placeholder.
      await manager.send(scope, created.id, 'what colour is it');
      const followUp = worker.last('run');
      const toolMessage = followUp.history.messages.find((message) => message.role === 'tool')!;
      expect(toolMessage.content).toEqual([
        { type: 'text', text: 'assets/shot.png: image image/png 8x6 (801 B).' },
        { type: 'image', attachment, dataBase64: png.toString('base64') },
      ]);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('refuses to replay an image whose stored bytes are gone', async () => {
    const userData = await createTempDataDir('iris-agent-manager-image-lost-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const png = pngFixture(8, 6);
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      toolExecutor: async () => ({
        result: {
          kind: 'image', mimeType: 'image/png', contentBase64: png.toString('base64'),
          bytes: png.byteLength, width: 8, height: 6,
        },
        update: { state: 'completed', completedAt: Date.now(), path: 'assets/shot.png' },
      }),
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, 'look');
      const run = worker.last('run');
      const first = providerCorrelation(run, 'lost-parent');
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: first, phase: 'started', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        eventId: 'event-lost-tool-call',
        correlation: first,
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tool-lost', name: 'read', arguments: { path: 'shot.png' } }],
          stopReason: 'toolUse',
        },
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: first, phase: 'completed', index: 1,
      });
      await vi.waitFor(() => expect(worker.messages).toContainEqual(expect.objectContaining({
        type: 'event-ack', eventId: 'event-lost-tool-call', ok: true,
      })));
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'tool-request',
        correlation: { ...run.correlation, toolCallId: 'tool-lost', operationId: 'operation-lost' },
        input: { tool: 'read', operation: 'readFile', absolutePath: 'shot.png' },
      });
      await vi.waitFor(() => expect(worker.last('tool-result')).toMatchObject({ ok: true }));

      const store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot: scope.root });
      const stored = store.get(created.id)!.toolOperations[0]!.result!;
      if (stored.kind !== 'image') throw new Error('expected a stored image result');
      const attachmentDir = join(
        dirname(agentSessionStorePath(userData, scope.root)),
        'sessions',
        createHash('sha256').update(created.id).digest('hex').slice(0, 32),
        'artifacts',
        'attachments',
      );
      await rm(join(attachmentDir, `${stored.attachmentId}.png`));

      worker.messages.length = 0;
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'tool-request',
        correlation: { ...run.correlation, toolCallId: 'tool-lost', operationId: 'operation-lost' },
        input: { tool: 'read', operation: 'readFile', absolutePath: 'shot.png' },
      });
      // No bytes means no image block: the model is told the stored image is
      // gone instead of being handed a fabricated one.
      await vi.waitFor(() => expect(worker.last('tool-result')).toMatchObject({
        ok: false,
        error: 'The stored image for this read is no longer available.',
      }));
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('carries user attachments through validation, storage, the request and history', async () => {
    const userData = await createTempDataDir('iris-agent-manager-user-image-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const png = pngFixture(640, 480);
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(
        scope,
        created.id,
        '看看这张图',
        { expectedRevision: created.revision },
        [{ name: 'shot.png', dataBase64: png.toString('base64') }],
      );

      const run = worker.last('run');
      // The Intents owns the images and they travel with the request itself,
      // because a still-running Intent is absent from `history`.
      expect(run.attachments).toEqual([
        expect.objectContaining({
          type: 'image',
          dataBase64: png.toString('base64'),
          attachment: expect.objectContaining({
            name: 'shot.png', mimeType: 'image/png', bytes: png.byteLength, width: 640, height: 480,
          }),
        }),
      ]);
      expect(run.history.messages.some((message) => message.role === 'user')).toBe(false);

      const opened = (await manager.list(scope)).sessions[0]!;
      const attachment = opened.intents[0]!.user.attachments![0]!;
      expect(attachment).toMatchObject({ name: 'shot.png', mimeType: 'image/png' });
      await expect(manager.readAttachmentData(scope, created.id, attachment.id)).resolves.toEqual({
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        error: null,
      });

      await settleRun(manager, worker, scope, created.id, run, '看见了。');

      // The bytes are delivered once, not copied into the journal.
      const persisted = (await IrisAgentSessionStore.load({
        userDataPath: userData, projectRoot: scope.root,
      })).get(created.id)!;
      expect(persisted.intents[0]!.attachments).toEqual([attachment]);
      expect(JSON.stringify(persisted)).not.toContain(png.toString('base64'));

      // A later request re-sends exactly the images the user attached.
      const followUp = (await manager.list(scope)).sessions[0]!;
      await manager.send(scope, created.id, '再确认一下', { expectedRevision: followUp.revision });
      const secondRun = worker.last('run');
      expect(secondRun.attachments).toBeUndefined();
      expect(secondRun.history.messages.find((message) => message.role === 'user')).toMatchObject({
        content: [
          { type: 'text', text: '看看这张图' },
          { type: 'image', attachment, dataBase64: png.toString('base64') },
        ],
      });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('rejects an unusable attachment instead of storing it', async () => {
    const userData = await createTempDataDir('iris-agent-manager-user-image-guard-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => new FakeWorker(),
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      const revision = created.revision;

      // SVG is refused on purpose; the renderer's claimed type is irrelevant
      // because the bytes are sniffed here.
      await expect(manager.send(scope, created.id, 'svg', { expectedRevision: revision }, [
        { name: 'vector.svg', dataBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') },
      ])).rejects.toThrow(/不是受支持的图片格式/);

      await expect(manager.send(scope, created.id, 'empty', { expectedRevision: revision }, [
        { name: 'broken.png', dataBase64: '' },
      ])).rejects.toThrow(/无效或超过/);

      const oversized = Buffer.concat([pngFixture(1, 1), Buffer.alloc(AGENT_IMAGE_MAX_BYTES + 1)]);
      await expect(manager.send(scope, created.id, 'huge', { expectedRevision: revision }, [
        { name: 'huge.png', dataBase64: oversized.toString('base64') },
      ])).rejects.toThrow(/5 MiB/);

      await expect(manager.send(scope, created.id, 'many', { expectedRevision: revision },
        Array.from({ length: AGENT_ATTACHMENT_MAX_COUNT + 1 }, (_value, index) => ({
          name: `shot-${String(index)}.png`,
          dataBase64: pngFixture(8, 6).toString('base64'),
        })),
      )).rejects.toThrow(/最多只能附带/);

      await expect(manager.send(scope, created.id, 'large dimensions', { expectedRevision: revision }, [
        { name: '4k.png', dataBase64: pngFixture(3840, 2160).toString('base64') },
      ])).rejects.toThrow(/1568px/);

      // Validation is batch-atomic: a valid first image must not be written
      // when a later image makes the request fail.
      await expect(manager.send(scope, created.id, 'mixed', { expectedRevision: revision }, [
        { name: 'valid.png', dataBase64: pngFixture(8, 6).toString('base64') },
        { name: 'invalid.svg', dataBase64: Buffer.from('<svg/>').toString('base64') },
      ])).rejects.toThrow(/不是受支持的图片格式/);

      const fourMiB = Buffer.concat([pngFixture(8, 6), Buffer.alloc(4 * 1024 * 1024)]);
      await expect(manager.send(scope, created.id, 'too much', { expectedRevision: revision }, [
        { name: 'one.png', dataBase64: fourMiB.toString('base64') },
        { name: 'two.png', dataBase64: fourMiB.toString('base64') },
        { name: 'three.png', dataBase64: fourMiB.toString('base64') },
      ])).rejects.toThrow(/12 MiB/);

      // A failure after persistence also rolls back files that never became
      // reachable from an Intent or mailbox entry.
      await expect(manager.send(scope, created.id, '', { expectedRevision: revision }, [
        { name: 'valid.png', dataBase64: pngFixture(8, 6).toString('base64') },
      ])).rejects.toThrow(/Enter a task/);

      const attachmentDir = join(
        dirname(agentSessionStorePath(userData, scope.root)),
        'sessions',
        createHash('sha256').update(created.id).digest('hex').slice(0, 32),
        'artifacts',
        'attachments',
      );
      const files = await readdir(attachmentDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      expect(files).toEqual([]);

      // Nothing was committed and no Intent was created by any rejected send.
      const after = (await manager.list(scope)).sessions[0]!;
      expect(after.intents).toHaveLength(0);
      expect(after.revision).toBe(revision);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('enforces image-input capability in main before storing an upload', async () => {
    const userData = await createTempDataDir('iris-agent-manager-user-image-model-guard-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const textOnlyCatalog: IrisAgentModelCatalog = {
      models: [{
        provider: 'openai', modelId: 'text-only', name: 'Text Only',
        api: 'openai-responses', reasoning: false,
        reasoningLevel: 'off', supportedReasoningLevels: ['off'],
        capabilities: { input: ['text'] },
      }],
    };
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => new FakeWorker(),
      modelCatalogLoader: async () => textOnlyCatalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await expect(manager.send(scope, created.id, 'look', { expectedRevision: created.revision }, [
        { name: 'shot.png', dataBase64: pngFixture(8, 6).toString('base64') },
      ])).rejects.toThrow(/不支持图片输入/);
      const current = (await manager.list(scope)).sessions[0]!;
      expect(current.intents).toHaveLength(0);
      expect(current.revision).toBe(created.revision);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('replays a queued request with the images it was queued with', async () => {
    const userData = await createTempDataDir('iris-agent-manager-user-image-queue-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const png = pngFixture(16, 16);
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, '第一件事');
      const firstRun = worker.last('run');

      // A second send while the first is still running is queued, not sent.
      const busy = (await manager.list(scope)).sessions[0]!;
      await manager.send(
        scope,
        created.id,
        '看看这张',
        { expectedRevision: busy.revision },
        [{ name: 'queued.png', dataBase64: png.toString('base64') }],
      );
      expect((await manager.list(scope)).sessions[0]!.queuedIntentCount).toBe(1);

      // Completing the first run lets the mailbox take over immediately, so this
      // settles without waiting for idle: the second request starts at once.
      const firstCorrelation = providerCorrelation(firstRun, 'queued-first');
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: firstCorrelation, phase: 'started', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        correlation: firstCorrelation,
        message: { role: 'assistant', content: [{ type: 'text', text: '第一件做完了。' }], stopReason: 'stop' },
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation: firstCorrelation, phase: 'completed', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'execution-settled', correlation: firstRun.correlation,
      });

      // Dispatching the mailbox entry must reuse the stored image, not ask the
      // renderer for it again.
      await vi.waitFor(() => {
        const dispatched = [...worker.messages]
          .reverse()
          .find((message) => message.type === 'run' && message !== firstRun);
        expect(dispatched).toMatchObject({
          attachments: [expect.objectContaining({ dataBase64: png.toString('base64') })],
        });
      });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('gives an input fork its own copy of the images it inherited', async () => {
    const userData = await createTempDataDir('iris-agent-manager-user-image-fork-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const png = pngFixture(32, 24);
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(
        scope,
        created.id,
        '看看这张',
        { expectedRevision: created.revision },
        [{ name: 'shot.png', dataBase64: png.toString('base64') }],
      );
      const run = worker.last('run');
      await settleRun(manager, worker, scope, created.id, run, '看见了。');
      const attachment = (await manager.list(scope)).sessions[0]!.intents[0]!.user.attachments![0]!;

      // A fork owns its own storage, so the inherited images must be copied or
      // the branch would reference files that only the source session has.
      // The Intent that carried the image, which is what an input fork targets.
      const sourceIntentId = (await manager.list(scope)).sessions[0]!.intents[0]!.id;
      const forked = await manager.branchFromInput(scope, created.id, sourceIntentId);
      const branch = (await manager.list(scope)).sessions.find(
        (session) => session.id === forked.id,
      )!;
      expect(branch.intents[0]!.user.attachments).toEqual([attachment]);
      await expect(manager.readAttachmentData(scope, forked.id, attachment.id)).resolves.toEqual({
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        error: null,
      });

      // The fork's input Intent has no Turns yet, so Continue re-sends the
      // whole request — including its picture.
      await manager.retry(scope, forked.id, { expectedRevision: branch.revision });
      expect(worker.last('run').attachments).toEqual([
        expect.objectContaining({ dataBase64: png.toString('base64') }),
      ]);
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
      // Closing Iris archives the instance: the next start sees it as history,
      // not as a live Session that is automatically resumed.
      const history = await secondManager.history(scope, { kind: 'workspace', path: '.iris' });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ closed: true });
      const restored = await secondManager.reopen(scope, history[0]!.id);
      await secondManager.retry(scope, restored.id, { expectedRevision: restored.revision });
      expect(secondWorker.last('initialize').history.messages.filter((message) => message.role === 'user')).toEqual([
        expect.objectContaining({ content: 'pause' }),
      ]);
      expect(secondWorker.last('initialize').history.messages.some(
        (message) => message.role === 'assistant' && historyText(message.content).includes('visible partial'),
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
        // Nobody is watching this terminal yet, so the command must not pay for
        // IPC: the mirror already holds the output for a later attach.
        expect(outputEvents).toHaveLength(0);
        expect(manager.attachTerminalOutput(scope, created.id, running.id, 'attach-1')).toBe(true);
        const replay = await manager.replayTerminal(scope, created.id, running.id, 80, 24);
        expect(Buffer.from(replay.data, 'base64').toString('utf8')).toContain('first');
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
        // The attach is what turns mirror writes into IPC delivery.
        await vi.waitFor(() => expect(
          outputEvents.some((event) => event.terminalId === running.id),
        ).toBe(true), { timeout: 5_000 });
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
  it(
    'keeps an exited terminal replayable for the output dialog',
    async () => {
      const userData = await createTempDataDir('iris-agent-manager-retained-');
      const scope: ProjectScope = { root: userData, generation: 1 };
      const worker = new FakeWorker();
      const manager = new IrisAgentSessionManager(userData, projectManager(), {
        workerFactory: () => worker,
        modelCatalogLoader: async () => catalog,
        terminalFactory: (options) => new FakeInteractiveTerminal(options) as unknown as AgentCommandPty,
        terminalDisplayThresholdMs: 20,
      });
      try {
        await manager.listModels();
        const created = await manager.createSession({
          scope,
          anchor: { kind: 'workspace', path: '.iris' },
        });
        await manager.send(scope, created.id, 'run a command');
        const run = worker.last('run');
        const provider = providerCorrelation(run, 'retained-terminal');
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
          eventId: 'event-retained-terminal',
          correlation: provider,
          message: {
            role: 'assistant',
            content: [{
              type: 'toolCall',
              id: 'tool-retained',
              name: 'terminal',
              arguments: { command: 'interactive' },
            }],
            stopReason: 'toolUse',
          },
        });
        await vi.waitFor(() => expect(worker.messages).toContainEqual(expect.objectContaining({
          type: 'event-ack',
          eventId: 'event-retained-terminal',
          ok: true,
        })));
        worker.emitMessage({
          version: IRIS_AGENT_PROTOCOL_VERSION,
          type: 'tool-request',
          correlation: {
            ...run.correlation,
            toolCallId: 'tool-retained',
            operationId: 'operation-retained',
          },
          input: {
            tool: 'terminal',
            operation: 'exec',
            command: 'interactive',
            intent: 'operation',
            timeout: 30,
            cwd: userData,
          },
        });
        await vi.waitFor(async () => {
          expect((await manager.list(scope)).sessions[0]?.terminals[0]).toMatchObject({ state: 'running' });
        }, { timeout: 5_000 });
        const terminal = (await manager.list(scope)).sessions[0]!.terminals[0]!;
        await manager.writeTerminal(scope, created.id, terminal.id, 'one\r');
        await manager.writeTerminal(scope, created.id, terminal.id, 'two\r');
        await vi.waitFor(async () => {
          expect((await manager.list(scope)).sessions[0]?.terminals[0]?.state).toBe('exited');
        }, { timeout: 5_000 });

        const replay = await manager.replayTerminal(scope, created.id, terminal.id, 80, 24);
        expect(Buffer.from(replay.data, 'base64').toString('utf8')).toContain('done:two');

        await manager.closeSession(scope, created.id, { confirmBusy: true });
        await expect(manager.replayTerminal(scope, created.id, terminal.id, 80, 24)).rejects.toThrow();
      } finally {
        await manager.shutdown();
        await removeTempDataDir(userData);
      }
    },
    15_000,
  );

  it(
    'delivers terminal output only while a dialog is attached and acks its backlog',
    async () => {
      const userData = await createTempDataDir('iris-agent-manager-attach-');
      const scope: ProjectScope = { root: userData, generation: 1 };
      const worker = new FakeWorker();
      const terminals: FakeInteractiveTerminal[] = [];
      const payloads: Array<{ terminalId: string; seq: number; data: string }> = [];
      const manager = new IrisAgentSessionManager(userData, projectManager(), {
        workerFactory: () => worker,
        modelCatalogLoader: async () => catalog,
        terminalFactory: (options) => {
          const terminal = new FakeInteractiveTerminal(options);
          terminals.push(terminal);
          return terminal as unknown as AgentCommandPty;
        },
        terminalDisplayThresholdMs: 20,
      });
      manager.on('terminalOutput', (event) => payloads.push(event));
      try {
        await manager.listModels();
        const created = await manager.createSession({
          scope,
          anchor: { kind: 'workspace', path: '.iris' },
        });
        await manager.send(scope, created.id, 'run a command');
        const run = worker.last('run');
        const provider = providerCorrelation(run, 'attach-gate');
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
          eventId: 'event-attach-gate',
          correlation: provider,
          message: {
            role: 'assistant',
            content: [{
              type: 'toolCall',
              id: 'tool-attach',
              name: 'terminal',
              arguments: { command: 'interactive' },
            }],
            stopReason: 'toolUse',
          },
        });
        await vi.waitFor(() => expect(worker.messages).toContainEqual(expect.objectContaining({
          type: 'event-ack',
          eventId: 'event-attach-gate',
          ok: true,
        })));
        worker.emitMessage({
          version: IRIS_AGENT_PROTOCOL_VERSION,
          type: 'tool-request',
          correlation: {
            ...run.correlation,
            toolCallId: 'tool-attach',
            operationId: 'operation-attach',
          },
          input: {
            tool: 'terminal',
            operation: 'exec',
            command: 'interactive',
            intent: 'operation',
            timeout: 30,
            cwd: userData,
          },
        });
        await vi.waitFor(async () => {
          expect((await manager.list(scope)).sessions[0]?.terminals[0]).toMatchObject({ state: 'running' });
        }, { timeout: 5_000 });
        const terminal = (await manager.list(scope)).sessions[0]!.terminals[0]!;
        await vi.waitFor(() => expect(terminals).toHaveLength(1), { timeout: 5_000 });

        // Detached: the command keeps running but nothing crosses the IPC gap.
        await manager.writeTerminal(scope, created.id, terminal.id, 'one\r');
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(payloads).toHaveLength(0);

        // A stale terminal id cannot enable delivery.
        expect(manager.attachTerminalOutput(scope, created.id, 'other-terminal', 'attach-2')).toBe(false);
        expect(manager.attachTerminalOutput(scope, created.id, terminal.id, 'attach-1')).toBe(true);
        const firstReplay = await manager.replayTerminal(scope, created.id, terminal.id, 80, 24);
        expect(Buffer.from(firstReplay.data, 'base64').toString('utf8'))
          .toContain('second:one');

        await manager.writeTerminal(scope, created.id, terminal.id, 'one\r');
        await vi.waitFor(() => expect(payloads.length).toBeGreaterThan(0), { timeout: 5_000 });
        const first = payloads[0]!;
        expect(first.terminalId).toBe(terminal.id);
        expect(Buffer.from(first.data, 'base64').toString()).toContain('second:one');
        // The ack of a sequence nobody emitted is ignored rather than releasing
        // a backlog that was never delivered.
        manager.acknowledgeTerminalOutput(scope, created.id, terminal.id, 'attach-2', first.seq + 10);
        expect(terminals[0]!.flowBlocked).toEqual([]);
        manager.acknowledgeTerminalOutput(scope, created.id, terminal.id, 'attach-1', first.seq);

        manager.detachTerminalOutput(scope, created.id, terminal.id, 'attach-1');
        const delivered = payloads.length;
        await manager.writeTerminal(scope, created.id, terminal.id, 'one\r');
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(payloads).toHaveLength(delivered);

        // Reattaching replays the mirror, so nothing was lost while detached.
        const replay = await manager.replayTerminal(scope, created.id, terminal.id, 80, 24);
        expect(Buffer.from(replay.data, 'base64').toString('utf8').match(/second:one/gu))
          .toHaveLength(3);

        await manager.writeTerminal(scope, created.id, terminal.id, 'two\r');
        await vi.waitFor(async () => {
          expect((await manager.list(scope)).sessions[0]?.terminals[0]?.state).toBe('exited');
        }, { timeout: 5_000 });
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
        reasoningLevel: 'off', supportedReasoningLevels: ['off'],
      },
      {
        provider: 'anthropic', modelId: 'claude-test', name: 'Claude Test',
        api: 'anthropic-messages', reasoning: false,
        reasoningLevel: 'off', supportedReasoningLevels: ['off'],
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

      const contents = worker.last('run').history.messages.map((message) => historyText(message.content));
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

      const contents = worker.last('run').history.messages.map((message) => historyText(message.content));
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
      const contents = worker.last('run').history.messages.map((message) => historyText(message.content));
      expect(contents.some((content) => content.includes('stable summary'))).toBe(true);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('drops the context reading as soon as a manual compaction lands', async () => {
    const userData = await createTempDataDir('iris-agent-compact-usage-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      summarizeContext: summarizer('compacted history'),
      compactionThresholds: { contextWindow: 100_000, reserveTokens: 1_000, keepRecentTokens: 1 },
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await settleIntent(manager, worker, scope, created.id, 'first message', 'first answer '.repeat(60));
      await settleIntent(manager, worker, scope, created.id, 'second message', 'second answer '.repeat(60));
      await settleIntent(manager, worker, scope, created.id, 'third message', 'third answer '.repeat(60));
      const before = (await manager.list(scope)).sessions[0]!;
      const usedBefore = before.contextUsage!.usedTokens;
      expect(before.contextBudget).toEqual({ windowTokens: 100_000, triggerTokens: 99_000 });

      const compacted = await manager.compact(scope, created.id, { expectedRevision: before.revision });
      expect(compacted.contextBudget).toEqual({ windowTokens: 100_000, triggerTokens: 99_000 });
      expect(compacted.contextUsage).toMatchObject({ measurement: 'estimated' });
      expect(compacted.contextUsage!.usedTokens).toBeLessThan(usedBefore);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('counts the pending request images when deciding whether to compact', async () => {
    const userData = await createTempDataDir('iris-agent-compact-pending-image-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const summarize = summarizer('image-triggered summary');
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      summarizeContext: summarize,
      compactionThresholds: {
        contextWindow: 5_000,
        reserveTokens: 1_000,
        keepRecentTokens: 1,
        triggerTokens: 3_000,
      },
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await settleIntent(manager, worker, scope, created.id, 'first', 'answer one');
      await settleIntent(manager, worker, scope, created.id, 'second', 'answer two');
      expect(summarize).not.toHaveBeenCalled();

      const before = (await manager.list(scope)).sessions[0]!;
      await manager.send(
        scope,
        created.id,
        'inspect image',
        { expectedRevision: before.revision },
        [{ name: 'large.png', dataBase64: pngFixture(1_000, 1_000).toString('base64') }],
      );
      expect(summarize).toHaveBeenCalledTimes(1);
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
      const image = pngFixture(640, 480);
      const started = await manager.send(
        scope,
        created.id,
        'third message',
        { expectedRevision: before.revision },
        [{ name: 'overflow.png', dataBase64: image.toString('base64') }],
      );
      const intentId = started.currentIntentId;
      const failedRun = firstWorker.last('run');
      firstWorker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'execution-paused',
        correlation: failedRun.correlation,
        reason: 'runtime-error',
        message: 'maximum context length exceeded',
      });
      await vi.waitFor(() => expect(retryWorker.last('run')).toMatchObject({
        prompt: expect.stringContaining('third message'),
        attachments: [expect.objectContaining({ dataBase64: image.toString('base64') })],
      }));
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

describe('Iris Agent context usage indicator', () => {
  /**
   * Runs one Intent to completion. The indicator's lifecycle fixes are about
   * quiescent Sessions, and a model cannot be switched mid-run, so these tests
   * need a settled run rather than a bare `send`.
   */
  async function settleIntent(
    manager: IrisAgentSessionManager,
    worker: FakeWorker,
    scope: ProjectScope,
    sessionId: string,
    message: string,
  ): Promise<void> {
    const before = (await manager.list(scope)).sessions.find((session) => session.id === sessionId)!;
    await manager.send(scope, sessionId, message, { expectedRevision: before.revision });
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
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], stopReason: 'stop' },
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
      expect(settled.pause?.message ?? settled.state).toBe('idle');
    });
  }

  it('re-resolves the window on a model switch and drops the stale reading', async () => {
    const userData = await createTempDataDir('iris-agent-usage-model-switch-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => ({
        models: [
          {
            provider: 'openai', modelId: 'gpt-test', name: 'GPT Test',
            api: 'openai-responses', reasoning: true,
            reasoningLevel: 'off', supportedReasoningLevels: ['off'],
            contextWindowTokens: 1_000_000,
            contextPolicy: { reserveOutputTokens: 16_384, keepRecentTokens: 20_000, compactTrigger: 983_616 },
          },
          {
            provider: 'openai', modelId: 'gpt-small', name: 'GPT Small',
            api: 'openai-responses', reasoning: true,
            reasoningLevel: 'off', supportedReasoningLevels: ['off'],
            contextWindowTokens: 128_000,
            contextPolicy: { reserveOutputTokens: 16_384, keepRecentTokens: 20_000, compactTrigger: 111_616 },
          },
        ],
      }),
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.setModel(scope, created.id, { provider: 'openai', modelId: 'gpt-test' });
      await settleIntent(manager, worker, scope, created.id, 'measure me');
      const sent = (await manager.list(scope)).sessions[0]!;
      expect(sent.contextBudget).toEqual({ windowTokens: 1_000_000, triggerTokens: 983_616 });
      expect(sent.contextUsage).toBeDefined();

      const switched = await manager.setModel(
        scope, created.id, { provider: 'openai', modelId: 'gpt-small' },
      );
      // The old reading was measured against the 1M window; showing it against
      // the 128K window would be a wrong percentage, so it is dropped.
      expect(switched.contextUsage).toBeUndefined();
      expect(switched.contextBudget).toEqual({ windowTokens: 128_000, triggerTokens: 111_616 });

      await settleIntent(manager, worker, scope, created.id, 'measure me again');
      const resent = (await manager.list(scope)).sessions[0]!;
      expect(resent.contextBudget).toEqual({ windowTokens: 128_000, triggerTokens: 111_616 });
      expect(resent.contextUsage!.usedTokens).toBeLessThan(128_000);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('resolves the window from the catalog even when nothing listed models yet', async () => {
    const userData = await createTempDataDir('iris-agent-usage-cold-cache-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => ({
        models: [{
          provider: 'openai', modelId: 'gpt-test', name: 'GPT Test',
          api: 'openai-responses', reasoning: true,
          reasoningLevel: 'off', supportedReasoningLevels: ['off'],
          contextWindowTokens: 1_000_000,
          contextPolicy: { reserveOutputTokens: 16_384, keepRecentTokens: 20_000, compactTrigger: 983_616 },
        }],
      }),
    });
    try {
      // No listModels() call first. Resolving the window straight from a cold
      // cache is what used to record a 1M model as the 128K default.
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      const selected = await manager.setModel(
        scope, created.id, { provider: 'openai', modelId: 'gpt-test' },
      );
      expect(selected.contextBudget).toEqual({ windowTokens: 1_000_000, triggerTokens: 983_616 });

      await settleIntent(manager, worker, scope, created.id, 'measure me');
      const sent = (await manager.list(scope)).sessions[0]!;
      // The reading is measured against the real window, not the default.
      expect(sent.contextBudget).toEqual({ windowTokens: 1_000_000, triggerTokens: 983_616 });
      expect(sent.contextUsage!.usedTokens).toBeLessThan(1_000_000);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('publishes an estimated reading before the first provider reply', async () => {
    const userData = await createTempDataDir('iris-agent-usage-estimate-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      compactionThresholds: { contextWindow: 100_000, reserveTokens: 1_000, keepRecentTokens: 20_000 },
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      const sent = await manager.send(scope, created.id, 'measure me');
      expect(sent.contextBudget).toEqual({ windowTokens: 100_000, triggerTokens: 99_000 });
      expect(sent.contextUsage).toMatchObject({ measurement: 'estimated' });
      expect(sent.contextUsage!.usedTokens).toBeGreaterThan(0);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('lets the provider counter replace the estimate and keeps the window budget', async () => {
    const userData = await createTempDataDir('iris-agent-usage-reported-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      compactionThresholds: { contextWindow: 200_000, reserveTokens: 2_000, keepRecentTokens: 20_000 },
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await manager.send(scope, created.id, 'measure me');
      const run = worker.last('run');
      const correlation = providerCorrelation(run, 'usage');
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation, phase: 'started', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        correlation,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          stopReason: 'stop',
          usage: { input: 1_000, output: 900, cacheRead: 500, cacheWrite: 100, totalTokens: 2_500 },
        },
      });
      await vi.waitFor(async () => {
        const current = (await manager.list(scope)).sessions[0]!;
        expect(current.contextUsage).toMatchObject({
          usedTokens: 1_600,
          measurement: 'reported',
        });
        expect(current.contextBudget).toEqual({ windowTokens: 200_000, triggerTokens: 198_000 });
      });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('keeps a tool loop measured when the provider reports no usage at all', async () => {
    const userData = await createTempDataDir('iris-agent-usage-missing-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      compactionThresholds: { contextWindow: 100_000, reserveTokens: 1_000, keepRecentTokens: 20_000 },
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      const sent = await manager.send(scope, created.id, 'measure me');
      const estimate = sent.contextUsage!.usedTokens;
      const run = worker.last('run');
      const correlation = providerCorrelation(run, 'no-usage');
      const reading = async () => (await manager.list(scope)).sessions[0]!.contextUsage!;

      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation, phase: 'started', index: 1,
      });
      // A provider that reports zeros must not erase the reading, and the answer
      // it just produced is now part of the history.
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        eventId: 'event-assistant-no-usage',
        correlation,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading the file.' },
            { type: 'toolCall', id: 'tool-loop', name: 'read', arguments: { path: 'README.md' } },
          ],
          stopReason: 'toolUse',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        },
      });
      await vi.waitFor(() => expect(worker.messages).toContainEqual(expect.objectContaining({
        type: 'event-ack', eventId: 'event-assistant-no-usage', ok: true,
      })));
      const afterAssistant = await reading();
      expect(afterAssistant.measurement).toBe('estimated');
      // The method layers are still counted, so the reading never falls back by
      // their size when a request is measured again.
      expect(afterAssistant.usedTokens).toBeGreaterThan(estimate);

      // The tool loop keeps appending history without a counter to follow it.
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-message',
        eventId: 'event-tool-loop-result',
        correlation: { ...run.correlation, toolCallId: 'tool-loop', providerMessageId: 'message-tool-loop' },
        message: {
          role: 'toolResult',
          toolCallId: 'tool-loop',
          content: [{ type: 'text', text: 'contents '.repeat(500) }],
          isError: false,
        },
      });
      await vi.waitFor(() => expect(worker.messages).toContainEqual(expect.objectContaining({
        type: 'event-ack', eventId: 'event-tool-loop-result', ok: true,
      })));
      const afterTool = await reading();
      expect(afterTool.measurement).toBe('estimated');
      // 500 latin words are at least 1K estimated tokens; the reading follows
      // the growing history instead of freezing at the run's first number.
      expect(afterTool.usedTokens).toBeGreaterThan(afterAssistant.usedTokens + 1_000);

      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'provider-attempt', correlation, phase: 'completed', index: 1,
      });
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'execution-settled',
        correlation: run.correlation,
      });
      await vi.waitFor(async () => {
        expect((await manager.list(scope)).sessions[0]?.state).toBe('idle');
      });
      expect((await reading()).usedTokens).toBeGreaterThanOrEqual(afterTool.usedTokens);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('drops a reading that was measured against rewound history', async () => {
    const userData = await createTempDataDir('iris-agent-usage-rewind-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const worker = new FakeWorker();
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => worker,
      modelCatalogLoader: async () => catalog,
      compactionThresholds: { contextWindow: 100_000, reserveTokens: 1_000, keepRecentTokens: 20_000 },
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope, anchor: { kind: 'workspace', path: '.iris' } });
      await settleIntent(manager, worker, scope, created.id, 'first question');
      await settleIntent(manager, worker, scope, created.id, 'second question');
      const measured = (await manager.list(scope)).sessions[0]!;
      expect(measured.contextUsage?.usedTokens).toBeGreaterThan(0);

      const rewound = await manager.rewind(scope, created.id, { expectedRevision: measured.revision });
      // The reading described history that no longer exists; the window did not
      // change with it, so only the reading goes away.
      expect(rewound.contextUsage).toBeUndefined();
      expect(rewound.contextBudget).toEqual({ windowTokens: 100_000, triggerTokens: 99_000 });

      const empty = await manager.rewind(scope, created.id, { expectedRevision: rewound.revision });
      expect(empty.contextUsage).toBeUndefined();
      expect(empty.canRewindLatestIntent).toBe(false);

      // The next request measures the new, shorter history and shows again.
      await settleIntent(manager, worker, scope, created.id, 'third question');
      const remeasured = (await manager.list(scope)).sessions[0]!;
      expect(remeasured.contextUsage?.usedTokens).toBeGreaterThan(0);
      expect(remeasured.contextBudget).toEqual({ windowTokens: 100_000, triggerTokens: 99_000 });
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

describe('Iris Agent instance lifecycle', () => {
  const workspaceAnchor = { kind: 'workspace' as const, path: '.iris' };

  async function runOneIntentToIdle(
    manager: IrisAgentSessionManager,
    scope: ProjectScope,
    workers: FakeWorker[],
    sessionId: string,
    message = 'do work',
  ): Promise<void> {
    await manager.send(scope, sessionId, message);
    const worker = workers[0]!;
    const run = worker.last('run');
    emitReply(worker, run, 'a', 'answer');
    const correlation = providerCorrelation(run, 'a');
    worker.emitMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'provider-message',
      correlation,
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], stopReason: 'stop' },
    });
    worker.emitMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'provider-attempt',
      correlation,
      phase: 'completed',
      index: 1,
    });
    worker.emitMessage({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'execution-settled',
      correlation: run.correlation,
    });
    await vi.waitFor(async () => {
      expect((await manager.list(scope)).sessions.find((session) => session.id === sessionId)?.state)
        .toBe('idle');
    });
  }

  it('archives a closed instance instead of deleting its conversation', async () => {
    const userData = await createTempDataDir('iris-agent-close-archive-');
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
      const created = await manager.createSession({ scope, anchor: workspaceAnchor });
      await runOneIntentToIdle(manager, scope, workers, created.id);

      await manager.closeSession(scope, created.id, { confirmBusy: true });

      // Gone from the live projection...
      expect((await manager.list(scope)).sessions).toHaveLength(0);
      // ...but preserved, with its conversation, as history.
      const history = await manager.history(scope, workspaceAnchor);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        id: created.id, closed: true, intentCount: 1, lastUserMessage: 'do work',
      });

      const reopened = await manager.reopen(scope, created.id);
      expect(reopened.id).toBe(created.id);
      expect(reopened.closedAt).toBeUndefined();
      const live = (await manager.list(scope)).sessions[0]!;
      expect(live.id).toBe(created.id);
      expect(live.intents[0]?.cards[0]).toMatchObject({ content: 'answer', state: 'completed' });
      expect((await manager.history(scope, workspaceAnchor))[0]).toMatchObject({ closed: false });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('restores a history instance into a new live Session and leaves the source closed', async () => {
    const userData = await createTempDataDir('iris-agent-restore-');
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
      const created = await manager.createSession({ scope, anchor: workspaceAnchor });
      await runOneIntentToIdle(manager, scope, workers, created.id);
      await manager.closeSession(scope, created.id, { confirmBusy: true });

      const restored = await manager.restore(scope, created.id);
      expect(restored.id).not.toBe(created.id);
      expect(restored.parentSessionId).toBe(created.id);
      expect(restored.anchor).toEqual(workspaceAnchor);
      // The inherited Trace makes the new instance continue the conversation.
      expect(restored.intents[0]?.user.content).toBe('do work');
      expect((await manager.list(scope)).sessions.map((session) => session.id))
        .toEqual([restored.id]);
      const history = await manager.history(scope, workspaceAnchor);
      expect(history.find((entry) => entry.id === created.id)).toMatchObject({ closed: true });
      expect(history.find((entry) => entry.id === restored.id)).toMatchObject({ closed: false });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('supersedes queued mailbox work when an instance is archived', async () => {
    const userData = await createTempDataDir('iris-agent-close-mailbox-');
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
      const created = await manager.createSession({ scope, anchor: workspaceAnchor });
      await manager.send(scope, created.id, 'first');
      await manager.send(scope, created.id, 'queued second');
      expect((await manager.list(scope)).sessions[0]?.queuedIntentCount).toBe(1);

      await manager.closeSession(scope, created.id, { confirmBusy: true });
      const reopened = await manager.reopen(scope, created.id);

      expect(reopened.queuedIntentCount).toBe(0);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('archives every live Session before switching away from a project', async () => {
    const userData = await createTempDataDir('iris-agent-project-switch-archive-');
    const scopeA: ProjectScope = { root: join(userData, 'project-a'), generation: 1 };
    const scopeB: ProjectScope = { root: join(userData, 'project-b'), generation: 2 };
    const manager = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: () => new FakeWorker(),
      modelCatalogLoader: async () => catalog,
    });
    try {
      await manager.listModels();
      const created = await manager.createSession({ scope: scopeA, anchor: workspaceAnchor });
      await manager.closeProject(scopeA);
      await manager.list(scopeB);

      expect((await manager.list(scopeA)).sessions).toHaveLength(0);
      expect((await manager.history(scopeA, workspaceAnchor)).find((entry) => entry.id === created.id))
        .toMatchObject({ closed: true });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(userData);
    }
  });

  it('archives every live instance on shutdown so the next start has no active dots', async () => {
    const userData = await createTempDataDir('iris-agent-shutdown-archive-');
    const scope: ProjectScope = { root: userData, generation: 1 };
    const workers: FakeWorker[] = [];
    const factory = (): FakeWorker => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
    const first = new IrisAgentSessionManager(userData, projectManager(), {
      workerFactory: factory,
      modelCatalogLoader: async () => catalog,
    });
    let second: IrisAgentSessionManager | null = null;
    try {
      await first.listModels();
      const idle = await first.createSession({ scope, anchor: workspaceAnchor });
      const busy = await first.createSession({ scope, anchor: workspaceAnchor });
      await first.send(scope, busy.id, 'still working');
      await first.shutdown();

      second = new IrisAgentSessionManager(userData, projectManager(), {
        workerFactory: factory,
        modelCatalogLoader: async () => catalog,
      });
      // Nothing resumes automatically: the closed instances are history only.
      expect((await second.list(scope)).sessions).toHaveLength(0);
      const history = await second.history(scope, workspaceAnchor);
      expect(history.map((entry) => entry.id).sort()).toEqual([idle.id, busy.id].sort());
      expect(history.every((entry) => entry.closed)).toBe(true);
      expect(second.countOpenSessions()).toBe(0);
    } finally {
      await first.shutdown();
      await second?.shutdown();
      await removeTempDataDir(userData);
    }
  });
});
