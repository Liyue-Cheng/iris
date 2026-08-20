import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  IRIS_AGENT_PROTOCOL_VERSION,
  agentHistoryDigest,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from '@shared/agent-protocol';
import type { IrisAgentModelCatalog, ProjectScope } from '@shared/types';
import type { ProjectManager } from '../project-manager';
import { createTempDataDir, removeTempDataDir } from '../persistence';
import type { AgentWorkerPort } from './worker-host';
import type { IrisAgentToolHostResult } from './tool-host';
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

  postMessage(message: AgentWorkerRequest): void {
    this.messages.push(message);
    if (message.type === 'initialize') {
      queueMicrotask(() => this.emitMessage({
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
      }));
    }
  }

  terminate = vi.fn(async () => {
    this.emit('exit', 0);
    return 0;
  });

  emitMessage(message: AgentWorkerEvent): void {
    this.emit('message', message);
  }

  last<T extends AgentWorkerRequest['type']>(type: T): Extract<AgentWorkerRequest, { type: T }> {
    const message = [...this.messages].reverse().find((candidate) => candidate.type === type);
    if (!message) throw new Error(`Missing Worker request ${type}`);
    return message as Extract<AgentWorkerRequest, { type: T }>;
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
