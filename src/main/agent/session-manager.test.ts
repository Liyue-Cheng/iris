import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  IRIS_AGENT_PROTOCOL_VERSION,
  agentHistoryDigest,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from '@shared/agent-protocol';
import {
  applyIrisAgentProviderMessage,
  applyIrisAgentMessageRewind,
  createIrisAgentBranch,
  IrisAgentSessionManager,
  parseElectronProxyRules,
  settleIrisAgentTurn,
} from './session-manager';
import type { AgentWorkerPort } from './worker-host';
import { createTempDataDir, removeTempDataDir } from '../persistence';
import type { ProjectManager } from '../project-manager';
import type { IrisAgentModelCatalog, IrisAgentSessionInfo } from '@shared/types';

const testModelCatalog: IrisAgentModelCatalog = {
  models: [{
    provider: 'openai',
    modelId: 'gpt-test',
    name: 'GPT Test',
    api: 'openai-responses',
    reasoning: true,
  }],
};

const baseSession: IrisAgentSessionInfo = {
  id: 'agent-1',
  kind: 'iris-agent',
  anchor: { kind: 'document', path: '.iris/issue/task.md' },
  model: { provider: 'openai', modelId: 'gpt-test' },
  projectRoot: 'E:/project',
  projectGeneration: 1,
  displayName: 'Iris Agent',
  state: 'idle',
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  workerEpoch: 0,
  activeTurnId: null,
  messages: [
    { id: 'u1', turnId: 'turn-1', role: 'user', content: 'one', createdAt: 1 },
    { id: 'a1', turnId: 'turn-1', role: 'assistant', content: 'done one', createdAt: 2 },
    { id: 'u2', turnId: 'turn-2', role: 'user', content: 'two', createdAt: 3 },
    { id: 'a2', turnId: 'turn-2', role: 'assistant', content: 'done two', createdAt: 4 },
  ],
  turns: [
    {
      id: 'turn-1',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      requestId: 'request-1',
      promptAvailable: true,
      status: 'completed',
      createdAt: 1,
      completedAt: 2,
    },
    {
      id: 'turn-2',
      userMessageId: 'u2',
      assistantMessageId: 'a2',
      requestId: 'request-2',
      promptAvailable: true,
      status: 'completed',
      createdAt: 3,
      completedAt: 4,
    },
  ],
  toolEvents: [
    {
      id: 'tool-2',
      turnId: 'turn-2',
      requestId: 'request-2',
      name: 'read',
      state: 'completed',
      createdAt: 3,
      inputSummary: 'read src/file.ts',
    },
  ],
  fileEffects: [
    {
      id: 'effect-2',
      turnId: 'turn-2',
      toolCallId: 'tool-2',
      path: 'src/file.ts',
      kind: 'edit',
      beforeSha256: 'before',
      afterSha256: 'after',
      beforeContent: 'before',
      afterContent: 'after',
      createdAt: 3,
    },
  ],
  requestFacts: [
    {
      id: 'request-1',
      turnId: 'turn-1',
      createdAt: 1,
      promptFingerprint: 'prompt-1',
      layerFingerprints: { agent: 'g1', software: 's1', project: 'p1', anchor: 'a1' },
      anchor: { kind: 'document', path: '.iris/issue/task.md' },
      promptChars: 100,
      redacted: true,
    },
    {
      id: 'request-2',
      turnId: 'turn-2',
      createdAt: 3,
      promptFingerprint: 'prompt-2',
      layerFingerprints: { agent: 'g2', software: 's2', project: 'p2', anchor: 'a2' },
      anchor: { kind: 'document', path: '.iris/issue/task.md' },
      promptChars: 120,
      redacted: true,
    },
  ],
  selfHostingEligible: false,
};

class SessionManagerWorker extends EventEmitter implements AgentWorkerPort {
  readonly messages: AgentWorkerRequest[] = [];
  private readonly termination: Promise<void>;
  private releaseTermination: (() => void) | null = null;
  private terminated = false;

  constructor(blockTermination: boolean) {
    super();
    this.termination = blockTermination
      ? new Promise<void>((resolve) => {
          this.releaseTermination = resolve;
        })
      : Promise.resolve();
  }

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
    await this.termination;
    if (!this.terminated) {
      this.terminated = true;
      this.emit('exit', 0);
    }
    return 0;
  });

  releaseTerminate(): void {
    this.releaseTermination?.();
    this.releaseTermination = null;
  }

  emitMessage(message: AgentWorkerEvent): void {
    this.emit('message', message);
  }

  latestRun(): Extract<AgentWorkerRequest, { type: 'run' }> {
    const run = [...this.messages].reverse().find(
      (message): message is Extract<AgentWorkerRequest, { type: 'run' }> => message.type === 'run',
    );
    if (!run) throw new Error('Expected the fake Worker to receive a run request.');
    return run;
  }
}

describe('Iris Agent system proxy rules', () => {
  it('uses the first supported Electron proxy decision in order', () => {
    expect(parseElectronProxyRules('PROXY 127.0.0.1:7890; DIRECT')).toEqual({
      mode: 'proxy',
      url: 'http://127.0.0.1:7890/',
    });
    expect(parseElectronProxyRules('HTTPS proxy.example.test:8443')).toEqual({
      mode: 'proxy',
      url: 'https://proxy.example.test:8443/',
    });
    expect(parseElectronProxyRules('DIRECT; PROXY 127.0.0.1:7890')).toEqual({ mode: 'direct' });
    expect(parseElectronProxyRules('SOCKS5 127.0.0.1:1080; DIRECT')).toEqual({ mode: 'direct' });
  });

  it('reports unsupported proxy results explicitly', () => {
    expect(() => parseElectronProxyRules('SOCKS5 127.0.0.1:1080')).toThrow(/SOCKS/);
    expect(() => parseElectronProxyRules('UNKNOWN proxy.example.test:80')).toThrow(/unsupported/);
  });
});

function finishWorkerTurn(worker: SessionManagerWorker, answer: string): void {
  const run = worker.latestRun();
  worker.emitMessage({
    version: IRIS_AGENT_PROTOCOL_VERSION,
    type: 'stream',
    correlation: run.correlation,
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: answer },
    },
  });
  worker.emitMessage({
    version: IRIS_AGENT_PROTOCOL_VERSION,
    type: 'stream',
    correlation: run.correlation,
    event: { type: 'agent_end' },
  });
}

describe('IrisAgentSessionManager tool activity', () => {
  it('collapses low-level operations from one provider tool call into one event', async () => {
    const dataDir = await createTempDataDir('iris-agent-tool-activity-');
    const projectRoot = await createTempDataDir('iris-agent-tool-project-');
    const worker = new SessionManagerWorker(false);
    const projectManager = {
      readDoc: vi.fn(async (path: string) => ({ path, raw: '# Focus' })),
      assertProjectSettingsReady: vi.fn(async () => undefined),
      softwarePromptState: vi.fn(async () => ({ project: { text: '# Project' } })),
    } as unknown as ProjectManager;
    const manager = new IrisAgentSessionManager(dataDir, projectManager, {
      workerFactory: () => worker,
      workerIdleTimeoutMs: 60_000,
      modelCatalogLoader: async () => testModelCatalog,
    });
    const scope = { root: projectRoot, generation: 1 };
    const target = join(projectRoot, 'value.txt');
    await writeFile(target, 'value', 'utf8');

    try {
      const opened = await manager.createSession({
        scope,
        anchor: { kind: 'document', path: '.iris/issue/task.md' },
      });
      await manager.send(scope, opened.id, 'read value');
      const run = worker.latestRun();
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'tool-request',
        correlation: {
          ...run.correlation,
          toolCallId: 'provider-call-1',
          operationId: 'operation-1',
        },
        input: { tool: 'read', operation: 'access', absolutePath: target },
      });
      await vi.waitFor(() => expect(worker.messages).toContainEqual(expect.objectContaining({
        type: 'tool-result',
        correlation: expect.objectContaining({ operationId: 'operation-1' }),
      })));
      worker.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'tool-request',
        correlation: {
          ...run.correlation,
          toolCallId: 'provider-call-1',
          operationId: 'operation-2',
        },
        input: { tool: 'read', operation: 'readFile', absolutePath: target },
      });
      await vi.waitFor(async () => {
        const event = (await manager.list(scope)).sessions[0]?.toolEvents[0];
        expect(event).toMatchObject({
          id: 'provider-call-1',
          name: 'read',
          operation: 'readFile',
          state: 'completed',
          resultSummary: '5 bytes',
        });
        expect((await manager.list(scope)).sessions[0]?.toolEvents).toHaveLength(1);
      });
      finishWorkerTurn(worker, 'done');
    } finally {
      await manager.shutdown();
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });
});

describe('IrisAgentSessionManager rewind', () => {
  it('removes exactly the latest terminal turn and retains real-world effect facts', () => {
    const rewound = applyIrisAgentMessageRewind({ ...baseSession, lastError: 'stale' });

    expect(rewound.turns.map((turn) => turn.id)).toEqual(['turn-1']);
    expect(rewound.messages.map((message) => message.id)).toEqual(['u1', 'a1']);
    expect(rewound.toolEvents).toEqual([]);
    expect(rewound.fileEffects).toEqual(baseSession.fileEffects);
    expect(rewound.requestFacts.map((facts) => facts.id)).toEqual(['request-1']);
    expect(rewound.turns[0]?.promptAvailable).toBe(true);
    expect(rewound.state).toBe('idle');
    expect(rewound.lastError).toBe('');
  });

  it('rejects a running latest turn', () => {
    const running = {
      ...baseSession,
      turns: [...baseSession.turns, {
        id: 'turn-3',
        userMessageId: 'u3',
        requestId: 'request-3',
        status: 'running' as const,
        createdAt: 5,
      }],
    };

    expect(() => applyIrisAgentMessageRewind(running)).toThrow(/still running/);
  });

  it('rejects a latest turn whose tools are not settled', () => {
    const unsettled = {
      ...baseSession,
      toolEvents: [{
        id: 'tool-1',
        turnId: 'turn-2',
        requestId: 'request-2',
        name: 'read' as const,
        state: 'running' as const,
        createdAt: 1,
        inputSummary: 'read issue',
      }],
    };

    expect(() => applyIrisAgentMessageRewind(unsettled)).toThrow(/unsettled tool call/);
  });

  it.each(['stopped', 'failed'] as const)('allows undoing a latest %s turn', (status) => {
    const session = {
      ...baseSession,
      turns: baseSession.turns.map((turn, index) => index === 1 ? { ...turn, status } : turn),
    };

    expect(applyIrisAgentMessageRewind(session).turns.map((turn) => turn.id)).toEqual(['turn-1']);
  });
});

describe('IrisAgentSessionManager branch', () => {
  it('copies only the selected conversation prefix and model identity', () => {
    const source = structuredClone(baseSession);
    const branch = createIrisAgentBranch(
      source,
      'turn-1',
      'branch-1',
      'Iris Agent Branch 1',
      10,
    );

    expect(branch).toMatchObject({
      id: 'branch-1',
      parentSessionId: source.id,
      forkedFromTurnId: 'turn-1',
      model: source.model,
      state: 'ready',
      activeTurnId: null,
      revision: 0,
      workerEpoch: 0,
    });
    expect(branch.turns.map((turn) => turn.id)).toEqual(['turn-1']);
    expect(branch.messages.map((message) => message.id)).toEqual(['u1', 'a1']);
    expect(branch.turns[0]).not.toHaveProperty('promptAvailable');
    expect(branch.toolEvents).toEqual([]);
    expect(branch.fileEffects).toEqual([]);
    expect(branch.requestFacts).toEqual([]);
    expect(branch).not.toHaveProperty('undoReceipts');
    expect(source.turns).toHaveLength(2);
    expect(source.toolEvents).toHaveLength(1);
    expect(source.fileEffects).toHaveLength(1);
  });

  it('rejects a missing or incomplete branch point', () => {
    expect(() => createIrisAgentBranch(
      baseSession,
      'missing',
      'branch-1',
      'Branch',
      10,
    )).toThrow(/not found/);
    const running = {
      ...baseSession,
      state: 'running' as const,
      activeTurnId: 'turn-2',
      turns: baseSession.turns.map((turn) =>
        turn.id === 'turn-2' ? { ...turn, status: 'running' as const } : turn),
    };
    expect(() => createIrisAgentBranch(running, 'turn-2', 'branch-1', 'Branch', 10))
      .toThrow(/before changing conversation history/);
  });
});

describe('IrisAgentSessionManager turn settlement', () => {
  const correlation = { sessionId: 'agent-1', requestId: 'request-2', turnId: 'turn-2' };

  function runningSession(stopRequested = false): IrisAgentSessionInfo {
    return {
      ...baseSession,
      state: stopRequested ? 'stopping' : 'running',
      activeTurnId: 'turn-2',
      ...(stopRequested ? { stopRequestedTurnId: 'turn-2' } : {}),
      turns: baseSession.turns.map((turn) => {
        if (turn.id !== 'turn-2') return turn;
        const { completedAt: _completedAt, ...rest } = turn;
        return { ...rest, status: 'running' as const };
      }),
    };
  }

  it('makes stop intent win over agent_end followed by interrupted', () => {
    const running = runningSession(true);
    const afterAgentEnd = settleIrisAgentTurn(running, correlation, 'completed');
    const afterInterrupted = settleIrisAgentTurn(
      afterAgentEnd,
      correlation,
      'stopped',
      'Stopped by user.',
    );

    expect(afterAgentEnd.turns[1]).toMatchObject({ status: 'stopped', error: 'Stopped by user.' });
    expect(afterAgentEnd.activeTurnId).toBeNull();
    expect(afterAgentEnd.messages).toEqual(running.messages);
    expect(afterInterrupted).toBe(afterAgentEnd);
  });

  it('keeps a stopped terminal result when interrupted arrives before agent_end', () => {
    const interrupted = settleIrisAgentTurn(
      runningSession(true),
      correlation,
      'stopped',
      'Stopped by user.',
    );
    expect(settleIrisAgentTurn(interrupted, correlation, 'completed')).toBe(interrupted);
    expect(settleIrisAgentTurn(interrupted, correlation, 'stopped')).toBe(interrupted);
  });

  it('ignores duplicate and stale terminal events', () => {
    const running = runningSession();
    const stale = settleIrisAgentTurn(running, {
      sessionId: 'agent-1',
      requestId: 'request-1',
      turnId: 'turn-1',
    }, 'completed');
    expect(stale).toBe(running);

    const completed = settleIrisAgentTurn(running, correlation, 'completed');
    expect(completed.turns[1]?.status).toBe('completed');
    expect(settleIrisAgentTurn(completed, correlation, 'failed', 'late')).toBe(completed);
  });

  it('settles a Worker failure during stop as stopped', () => {
    const failed = settleIrisAgentTurn(runningSession(true), correlation, 'failed', 'crashed');
    expect(failed.state).toBe('idle');
    expect(failed.turns[1]).toMatchObject({ status: 'stopped', error: 'Stopped by user.' });
  });

  it('does not classify an empty stopped partial as completed', () => {
    const running = runningSession(true);
    running.messages = running.messages.map((message) => message.id === 'a2'
      ? { ...message, content: '' }
      : message);
    const stopped = settleIrisAgentTurn(running, correlation, 'completed');
    expect(stopped.turns[1]?.status).toBe('stopped');
    expect(stopped.messages.find((message) => message.id === 'a2')?.content).toBe('');
  });
});

describe('IrisAgentSessionManager provider history', () => {
  it('preserves ordered intermediate assistant tool calls without replacing the visible answer', () => {
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    let session = applyIrisAgentProviderMessage(baseSession, {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-b', name: 'read', arguments: { path: 'b.md' } }],
      api: 'openai-responses',
      provider: 'provider',
      model: 'model',
      usage,
      stopReason: 'toolUse',
      timestamp: 5,
    }, 'turn-2');
    session = applyIrisAgentProviderMessage(session, {
      role: 'toolResult',
      toolCallId: 'call-b',
      toolName: 'read',
      content: [{ type: 'text', text: 'result b' }],
      isError: false,
      timestamp: 6,
    }, 'turn-2');
    session = applyIrisAgentProviderMessage(session, {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-c', name: 'read', arguments: { path: 'c.md' } }],
      api: 'openai-responses',
      provider: 'provider',
      model: 'model',
      usage,
      stopReason: 'toolUse',
      timestamp: 7,
    }, 'turn-2');
    session = applyIrisAgentProviderMessage(session, {
      role: 'toolResult',
      toolCallId: 'call-c',
      toolName: 'read',
      content: [{ type: 'text', text: 'result c' }],
      isError: false,
      timestamp: 8,
    }, 'turn-2');
    session = applyIrisAgentProviderMessage(session, {
      role: 'assistant',
      content: [{ type: 'text', text: 'final answer' }],
      api: 'openai-responses',
      provider: 'provider',
      model: 'model',
      usage,
      stopReason: 'stop',
      timestamp: 9,
    }, 'turn-2');

    const turnMessages = session.messages.filter((message) => message.turnId === 'turn-2');
    expect(turnMessages.map((message) => message.id)).toEqual([
      'u2',
      'pi-assistant:turn-2:call-b',
      'pi-tool:turn-2:call-b',
      'pi-assistant:turn-2:call-c',
      'pi-tool:turn-2:call-c',
      'a2',
    ]);
    expect(turnMessages.filter((message) => message.providerOnly)).toHaveLength(2);
    expect(turnMessages.find((message) => message.id === 'a2')).toMatchObject({
      content: 'final answer',
      providerMessage: { role: 'assistant', stopReason: 'stop' },
    });
    expect(turnMessages.find((message) => message.id === 'a2')).not.toHaveProperty('providerOnly');
  });
});

describe('IrisAgentSessionManager command transactions', () => {
  it('rejects a command based on a stale canonical revision before starting a Worker', async () => {
    const dataDir = await createTempDataDir('iris-agent-stale-revision-');
    const projectRoot = await createTempDataDir('iris-agent-stale-revision-project-');
    const workerFactory = vi.fn(() => new SessionManagerWorker(false));
    const projectManager = {
      readDoc: vi.fn(async (path: string) => ({ path, raw: '# Focus' })),
      assertProjectSettingsReady: vi.fn(async () => undefined),
      softwarePromptState: vi.fn(async () => ({ project: { text: '# Project' } })),
    } as unknown as ProjectManager;
    const manager = new IrisAgentSessionManager(dataDir, projectManager, {
      workerFactory,
      workerIdleTimeoutMs: 60_000,
      modelCatalogLoader: async () => testModelCatalog,
    });
    const scope = { root: projectRoot, generation: 1 };

    try {
      const opened = await manager.createSession({
        scope,
        anchor: { kind: 'document', path: '.iris/issue/task.md' },
      });
      const stale = {
        commandId: 'command-1',
        expectedRevision: opened.revision - 1,
      };
      await expect(manager.stop(scope, opened.id, stale)).rejects.toThrow(/expected revision/);
      await expect(manager.closeSession(scope, opened.id, stale)).rejects.toThrow(/expected revision/);
      await expect(manager.send(scope, opened.id, 'stale request', {
        commandId: 'command-2',
        expectedRevision: stale.expectedRevision,
      })).rejects.toThrow(/expected revision/);
      expect(workerFactory).not.toHaveBeenCalled();
      expect((await manager.list(scope)).sessions[0]?.turns).toEqual([]);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });

  it('retries the latest stopped turn from the preceding history prefix', async () => {
    const dataDir = await createTempDataDir('iris-agent-retry-prefix-');
    const projectRoot = await createTempDataDir('iris-agent-retry-project-');
    const workers: SessionManagerWorker[] = [];
    const projectManager = {
      readDoc: vi.fn(async (path: string) => ({ path, raw: '# Focus' })),
      assertProjectSettingsReady: vi.fn(async () => undefined),
      softwarePromptState: vi.fn(async () => ({ project: { text: '# Project' } })),
    } as unknown as ProjectManager;
    const manager = new IrisAgentSessionManager(dataDir, projectManager, {
      workerFactory: () => {
        const worker = new SessionManagerWorker(false);
        workers.push(worker);
        return worker;
      },
      workerIdleTimeoutMs: 60_000,
      modelCatalogLoader: async () => testModelCatalog,
    });
    const scope = { root: projectRoot, generation: 1 };

    try {
      const opened = await manager.createSession({
        scope,
        anchor: { kind: 'document', path: '.iris/issue/task.md' },
      });
      await manager.send(scope, opened.id, 'write a novel');
      const firstRun = workers[0]!.latestRun();
      workers[0]!.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'stream',
        correlation: firstRun.correlation,
        event: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'discarded partial' },
        },
      });
      await manager.stop(scope, opened.id);
      workers[0]!.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'state',
        correlation: firstRun.correlation,
        state: 'interrupted',
      });
      await vi.waitFor(async () => {
        expect((await manager.list(scope)).sessions[0]?.state).toBe('idle');
      });
      const stopped = (await manager.list(scope)).sessions[0]!;
      const stoppedTurnId = stopped.turns[0]!.id;

      const retried = await manager.retry(scope, opened.id);
      expect(retried.turns).toHaveLength(1);
      expect(retried.turns[0]).toMatchObject({
        status: 'running',
        retryOfTurnId: stoppedTurnId,
      });
      expect(retried.messages.map((message) => message.content)).toEqual(['write a novel', '']);
      expect(workers).toHaveLength(2);
      const initialize = workers[1]!.messages.find(
        (message): message is Extract<AgentWorkerRequest, { type: 'initialize' }> =>
          message.type === 'initialize',
      );
      expect(initialize?.history.messages).toEqual([]);
      expect(workers[1]!.latestRun().prompt).toContain('write a novel');
      expect(workers[1]!.latestRun().prompt).not.toContain('discarded partial');
    } finally {
      await manager.shutdown();
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });

  it('undoes only the latest turn after two consecutive stopped turns', async () => {
    const dataDir = await createTempDataDir('iris-agent-stop-stop-undo-');
    const projectRoot = await createTempDataDir('iris-agent-stop-stop-project-');
    const workers: SessionManagerWorker[] = [];
    const projectManager = {
      readDoc: vi.fn(async (path: string) => ({ path, raw: '# Focus' })),
      assertProjectSettingsReady: vi.fn(async () => undefined),
      softwarePromptState: vi.fn(async () => ({ project: { text: '# Project' } })),
    } as unknown as ProjectManager;
    const manager = new IrisAgentSessionManager(dataDir, projectManager, {
      workerFactory: () => {
        const worker = new SessionManagerWorker(false);
        workers.push(worker);
        return worker;
      },
      workerIdleTimeoutMs: 60_000,
      modelCatalogLoader: async () => testModelCatalog,
    });
    const scope = { root: projectRoot, generation: 1 };

    try {
      const opened = await manager.createSession({
        scope,
        anchor: { kind: 'document', path: '.iris/issue/task.md' },
      });

      await manager.send(scope, opened.id, 'write a novel');
      const firstRun = workers[0]!.latestRun();
      workers[0]!.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'stream',
        correlation: firstRun.correlation,
        event: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'first partial' },
        },
      });
      await manager.stop(scope, opened.id);
      workers[0]!.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'state',
        correlation: firstRun.correlation,
        state: 'interrupted',
      });
      await vi.waitFor(async () => {
        expect((await manager.list(scope)).sessions[0]?.turns[0]?.status).toBe('stopped');
      });

      await manager.send(scope, opened.id, 'continue');
      const secondRun = workers[0]!.latestRun();
      workers[0]!.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'stream',
        correlation: secondRun.correlation,
        event: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'second partial' },
        },
      });
      await manager.stop(scope, opened.id);
      workers[0]!.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'state',
        correlation: secondRun.correlation,
        state: 'interrupted',
      });
      await vi.waitFor(async () => {
        const current = (await manager.list(scope)).sessions[0]!;
        expect(current.turns.map((turn) => turn.status)).toEqual(['stopped', 'stopped']);
      });

      const rewound = await manager.rewind(scope, opened.id);
      expect(rewound.turns).toHaveLength(1);
      expect(rewound.turns[0]?.status).toBe('stopped');
      expect(rewound.messages.map((message) => message.content)).toEqual([
        'write a novel',
        'first partial',
      ]);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });

  it('serializes send with rewind and starts the replacement Worker from only the kept branch', async () => {
    const dataDir = await createTempDataDir('iris-agent-manager-');
    const projectRoot = await createTempDataDir('iris-agent-manager-project-');
    const workers: SessionManagerWorker[] = [];
    const projectManager = {
      readDoc: vi.fn(async (path: string) => ({ path, raw: '# Focus' })),
      assertProjectSettingsReady: vi.fn(async () => undefined),
      softwarePromptState: vi.fn(async () => ({ project: { text: '# Project' } })),
    } as unknown as ProjectManager;
    const manager = new IrisAgentSessionManager(dataDir, projectManager, {
      workerFactory: () => {
        const worker = new SessionManagerWorker(workers.length === 0);
        workers.push(worker);
        return worker;
      },
      workerIdleTimeoutMs: 60_000,
      modelCatalogLoader: async () => testModelCatalog,
    });
    const scope = { root: projectRoot, generation: 1 };

    try {
      const opened = await manager.createSession({
        scope,
        anchor: { kind: 'document', path: '.iris/issue/task.md' },
      });
      const firstSend = manager.send(scope, opened.id, 'first request');
      const duplicateSend = manager.send(scope, opened.id, 'duplicate request');
      await firstSend;
      await expect(duplicateSend).rejects.toThrow(/already running/);
      expect(workers).toHaveLength(1);
      expect(workers[0]!.messages.filter((message) => message.type === 'run')).toHaveLength(1);

      finishWorkerTurn(workers[0]!, 'first answer');
      await vi.waitFor(async () => {
        const snapshot = await manager.list(scope);
        expect(snapshot.sessions[0]?.state).toBe('idle');
      });
      await manager.send(scope, opened.id, 'second request');
      finishWorkerTurn(workers[0]!, 'second answer');
      await vi.waitFor(async () => {
        const snapshot = await manager.list(scope);
        expect(snapshot.sessions[0]?.turns).toHaveLength(2);
        expect(snapshot.sessions[0]?.state).toBe('idle');
      });

      const beforeRewind = (await manager.list(scope)).sessions[0]!;
      const keptTurnId = beforeRewind.turns[0]!.id;
      const rewind = manager.rewind(scope, opened.id);
      await vi.waitFor(() => expect(workers[0]!.terminate).toHaveBeenCalledTimes(1));

      const sendAfterRewind = manager.send(scope, opened.id, 'after rewind');
      expect((await manager.list(scope)).sessions[0]?.turns).toHaveLength(2);
      workers[0]!.releaseTerminate();

      const rewound = await rewind;
      const replacementRunning = await sendAfterRewind;
      expect(rewound.turns.map((turn) => turn.id)).toEqual([keptTurnId]);
      expect(replacementRunning.turns).toHaveLength(2);
      expect(replacementRunning.turns[0]?.id).toBe(keptTurnId);
      expect(workers).toHaveLength(2);

      const initialize = workers[1]!.messages.find(
        (message): message is Extract<AgentWorkerRequest, { type: 'initialize' }> =>
          message.type === 'initialize',
      );
      expect(initialize?.history.messages.map((message) => message.content)).toEqual([
        'first request',
        'first answer',
      ]);
      expect(initialize?.history.messages.every((message) => message.turnId === keptTurnId)).toBe(true);
      expect(workers[1]!.latestRun().prompt).toContain('after rewind');
      expect(workers[0]!.messages.filter((message) => message.type === 'run')).toHaveLength(2);

      workers[0]!.emitMessage({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'state',
        correlation: { sessionId: opened.id },
        state: 'starting',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((await manager.list(scope)).sessions[0]?.state).toBe('running');
    } finally {
      for (const worker of workers) worker.releaseTerminate();
      await manager.shutdown();
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });

  it('persists a model switch and initializes the replacement Worker with it', async () => {
    const dataDir = await createTempDataDir('iris-agent-model-switch-');
    const projectRoot = await createTempDataDir('iris-agent-model-switch-project-');
    const workers: SessionManagerWorker[] = [];
    const catalog: IrisAgentModelCatalog = {
      models: [
        ...testModelCatalog.models,
        {
          provider: 'openai',
          modelId: 'gpt-next',
          name: 'GPT Next',
          api: 'openai-responses',
          reasoning: true,
        },
      ],
    };
    const projectManager = {
      readDoc: vi.fn(async (path: string) => ({ path, raw: '# Focus' })),
      assertProjectSettingsReady: vi.fn(async () => undefined),
      softwarePromptState: vi.fn(async () => ({ project: { text: '# Project' } })),
    } as unknown as ProjectManager;
    const manager = new IrisAgentSessionManager(dataDir, projectManager, {
      workerFactory: () => {
        const worker = new SessionManagerWorker(false);
        workers.push(worker);
        return worker;
      },
      workerIdleTimeoutMs: 60_000,
      modelCatalogLoader: async () => catalog,
    });
    const scope = { root: projectRoot, generation: 1 };

    try {
      const opened = await manager.createSession({
        scope,
        anchor: { kind: 'document', path: '.iris/issue/task.md' },
      });
      expect(opened.model).toEqual({ provider: 'openai', modelId: 'gpt-test' });
      await manager.send(scope, opened.id, 'first request');
      finishWorkerTurn(workers[0]!, 'first answer');
      await vi.waitFor(async () => {
        expect((await manager.list(scope)).sessions[0]?.state).toBe('idle');
      });

      const beforeSwitch = (await manager.list(scope)).sessions[0]!;
      const switched = await manager.setModel(
        scope,
        opened.id,
        { provider: 'openai', modelId: 'gpt-next' },
        { expectedRevision: beforeSwitch.revision },
      );
      expect(switched.model).toEqual({ provider: 'openai', modelId: 'gpt-next' });
      expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);

      await manager.send(scope, opened.id, 'second request');
      expect(workers).toHaveLength(2);
      const initialize = workers[1]!.messages.find(
        (message): message is Extract<AgentWorkerRequest, { type: 'initialize' }> =>
          message.type === 'initialize',
      );
      expect(initialize?.runtime.model).toEqual({ provider: 'openai', modelId: 'gpt-next' });
      expect((await manager.list(scope)).sessions[0]?.model).toEqual({
        provider: 'openai',
        modelId: 'gpt-next',
      });
    } finally {
      await manager.shutdown();
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });

  it('rejects sending when the saved model is no longer available', async () => {
    const dataDir = await createTempDataDir('iris-agent-model-unavailable-');
    const projectRoot = await createTempDataDir('iris-agent-model-unavailable-project-');
    let catalog = testModelCatalog;
    const manager = new IrisAgentSessionManager(dataDir, {
      readDoc: vi.fn(async (path: string) => ({ path, raw: '# Focus' })),
      assertProjectSettingsReady: vi.fn(async () => undefined),
      softwarePromptState: vi.fn(async () => ({ project: { text: '# Project' } })),
    } as unknown as ProjectManager, {
      workerFactory: () => new SessionManagerWorker(false),
      workerIdleTimeoutMs: 60_000,
      modelCatalogLoader: async () => catalog,
    });
    const scope = { root: projectRoot, generation: 1 };

    try {
      const opened = await manager.createSession({
        scope,
        anchor: { kind: 'document', path: '.iris/issue/task.md' },
      });
      catalog = { models: [] };

      await expect(manager.send(scope, opened.id, 'must not run')).rejects.toThrow(/unavailable/);
      expect((await manager.list(scope)).sessions[0]?.turns).toEqual([]);
    } finally {
      await manager.shutdown();
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });
});
