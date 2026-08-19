import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createTempDataDir, removeTempDataDir } from '../persistence';
import { agentSessionStorePath, IrisAgentSessionStore } from './session-store';
import { sanitizeProviderPayload } from './context-artifact';
import type { IrisAgentSessionInfo } from '@shared/types';

function session(projectRoot: string, state: IrisAgentSessionInfo['state']): IrisAgentSessionInfo {
  return {
    id: 'agent-1',
    kind: 'iris-agent',
    anchor: { kind: 'document', path: '.iris/issue/task.md' },
    model: { provider: 'openai', modelId: 'gpt-test' },
    projectRoot,
    projectGeneration: 1,
    displayName: 'Iris Agent',
    state,
    createdAt: 1,
    updatedAt: 1,
    revision: 0,
    workerEpoch: 0,
    activeTurnId: 'turn-1',
    messages: [{
      id: 'user-1',
      turnId: 'turn-1',
      role: 'user',
      content: 'hello',
      createdAt: 1,
    }],
    turns: [{
      id: 'turn-1',
      userMessageId: 'user-1',
      requestId: 'request-1',
      promptAvailable: true,
      status: 'running',
      createdAt: 1,
    }],
    toolEvents: [],
    fileEffects: [],
    requestFacts: [],
    selfHostingEligible: false,
  };
}

describe('IrisAgentSessionStore', () => {
  it('migrates legacy sessions to explicit revisions, Worker epochs, and model state', async () => {
    const dataDir = await createTempDataDir('iris-agent-v2-store-');
    const projectRoot = await createTempDataDir('iris-agent-v2-project-');
    try {
      const filePath = agentSessionStorePath(dataDir, projectRoot);
      await mkdir(dirname(filePath), { recursive: true });
      const current = session(projectRoot, 'running');
      current.toolEvents = [{
        id: 'legacy-terminal',
        turnId: 'turn-1',
        requestId: 'request-1',
        name: 'terminal',
        state: 'completed',
        createdAt: 1,
        inputSummary: 'git status',
      }];
      const {
        revision: _revision,
        workerEpoch: _workerEpoch,
        model: _model,
        ...legacy
      } = current;
      await writeFile(filePath, JSON.stringify({
        version: 2,
        projectRoot,
        sessions: [legacy],
      }));

      const store = await IrisAgentSessionStore.load({ userDataPath: dataDir, projectRoot, debounceMs: 0 });
      expect(store.get('agent-1')).toMatchObject({
        revision: 0,
        workerEpoch: 0,
        model: null,
        toolEvents: [{ id: 'legacy-terminal', terminalIntent: 'unknown' }],
      });
      store.destroy();
    } finally {
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });

  it('assigns strictly increasing revisions to successive session updates', async () => {
    const dataDir = await createTempDataDir('iris-agent-revision-store-');
    const projectRoot = await createTempDataDir('iris-agent-revision-project-');
    try {
      const store = await IrisAgentSessionStore.load({ userDataPath: dataDir, projectRoot, debounceMs: 0 });
      const first = store.upsert(session(projectRoot, 'running'));
      const second = store.upsert({ ...first, updatedAt: 0, state: 'stopping' });

      expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
      expect(second.revision).toBe(first.revision + 1);
      expect(store.history('agent-1').revision).toBe(second.revision);
      store.destroy();
    } finally {
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });

  it('persists sessions and recovers interrupted turns after restart', async () => {
    const dataDir = await createTempDataDir('iris-agent-store-');
    const projectRoot = await createTempDataDir('iris-agent-project-');
    try {
      const first = await IrisAgentSessionStore.load({
        userDataPath: dataDir,
        projectRoot,
        debounceMs: 0,
      });
      first.upsert(session(projectRoot, 'running'));
      expect(first.history('agent-1').messages).toEqual([]);
      await first.savePromptSnapshot('agent-1', 'turn-1', 'complete prompt');
      await first.flush();
      first.destroy();

      const second = await IrisAgentSessionStore.load({
        userDataPath: dataDir,
        projectRoot,
        debounceMs: 0,
      });
      const [restored] = second.list({ root: projectRoot, generation: 2 });
      expect(restored?.state).toBe('failed');
      expect(restored?.projectGeneration).toBe(2);
      expect(restored?.activeTurnId).toBeNull();
      expect(restored?.turns[0]?.status).toBe('failed');
      expect(restored?.turns[0]).toMatchObject({
        artifactSchemaVersion: 1,
        assembledInputAvailable: true,
        assembledInputLegacy: true,
      });
      expect(restored?.turns[0]?.promptAvailable).toBeUndefined();
      await expect(readFile(second.promptSnapshotPath('agent-1', 'turn-1'), 'utf8'))
        .resolves.toBe('complete prompt');
      second.destroy();
    } finally {
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });

  it('recovers an acknowledged stop intent as stopped after restart', async () => {
    const dataDir = await createTempDataDir('iris-agent-stop-store-');
    const projectRoot = await createTempDataDir('iris-agent-stop-project-');
    try {
      const first = await IrisAgentSessionStore.load({ userDataPath: dataDir, projectRoot, debounceMs: 0 });
      const stopping = session(projectRoot, 'stopping');
      stopping.messages.push({
        id: 'assistant-1',
        turnId: 'turn-1',
        role: 'assistant',
        content: 'visible partial',
        createdAt: 2,
      });
      first.upsert({
        ...stopping,
        stopRequestedTurnId: 'turn-1',
      });
      await first.flush();
      first.destroy();

      const second = await IrisAgentSessionStore.load({ userDataPath: dataDir, projectRoot, debounceMs: 0 });
      const restored = second.get('agent-1');
      expect(restored?.state).toBe('idle');
      expect(restored?.activeTurnId).toBeNull();
      expect(restored?.stopRequestedTurnId).toBeUndefined();
      expect(restored?.turns[0]).toMatchObject({ status: 'stopped', error: 'Stopped by user.' });
      expect(restored?.messages[1]?.content).toBe('visible partial');
      second.destroy();
    } finally {
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });

  it('returns canonical stopped history including structured tool messages', async () => {
    const dataDir = await createTempDataDir('iris-agent-history-store-');
    const projectRoot = await createTempDataDir('iris-agent-history-project-');
    try {
      const store = await IrisAgentSessionStore.load({ userDataPath: dataDir, projectRoot, debounceMs: 0 });
      const value = session(projectRoot, 'idle');
      value.activeTurnId = null;
      value.turns[0] = { ...value.turns[0]!, status: 'stopped', completedAt: 2 };
      value.messages = [
        {
          ...value.messages[0]!,
          providerMessage: { role: 'user', content: 'hello', timestamp: 1 },
        },
        {
          id: 'assistant-tool-1',
          turnId: 'turn-1',
          role: 'assistant',
          content: '',
          createdAt: 2,
          providerOnly: true,
          providerMessage: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'file.md' } }],
            api: 'openai-responses',
            provider: 'provider',
            model: 'model',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'toolUse',
            timestamp: 2,
          },
        },
        {
          id: 'tool-1',
          turnId: 'turn-1',
          role: 'tool',
          content: 'result',
          createdAt: 2,
          providerMessage: {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'result' }],
            isError: false,
            timestamp: 2,
          },
        },
        {
          id: 'assistant-1',
          turnId: 'turn-1',
          role: 'assistant',
          content: 'final answer',
          createdAt: 3,
        },
      ];
      store.upsert(value);

      const history = store.history('agent-1');
      expect(history.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
      ]);
      expect(history.messages[1]?.providerMessage).toMatchObject({
        role: 'assistant',
        stopReason: 'toolUse',
      });
      expect(history.messages[2]?.providerMessage).toMatchObject({ role: 'toolResult', toolCallId: 'call-1' });
      expect(history.messages[3]?.content).toBe('final answer');
      store.destroy();
    } finally {
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });

  it('writes ordered provider calls to atomic JSON and deterministic text artifacts', async () => {
    const dataDir = await createTempDataDir('iris-agent-context-store-');
    const projectRoot = await createTempDataDir('iris-agent-context-project-');
    try {
      const store = await IrisAgentSessionStore.load({ userDataPath: dataDir, projectRoot, debounceMs: 0 });
      await store.appendProviderContext('agent-1', 'turn-1', 'request-1', {
        index: 1,
        capturedAt: 10,
        provider: 'openai',
        model: 'gpt-test',
        api: 'openai-responses',
        payload: {
          model: 'gpt-test',
          instructions: 'system prompt',
          input: [
            { role: 'user', content: 'previous request' },
            { role: 'assistant', content: 'stopped partial' },
            { role: 'user', content: 'continue' },
          ],
          tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
        },
      });
      const bundle = await store.appendProviderContext('agent-1', 'turn-1', 'request-1', {
        index: 2,
        capturedAt: 20,
        provider: 'openai',
        model: 'gpt-test',
        api: 'openai-responses',
        payload: { model: 'gpt-test', input: [{ role: 'tool', content: 'result' }] },
      }, true, {
        appVersion: '0.1.0-test',
        protocolVersion: 3,
        sessionRevision: 7,
        workerEpoch: 2,
      });
      expect(bundle.calls.map((call) => call.index)).toEqual([1, 2]);
      const json = await readFile(store.providerContextJsonPath('agent-1', 'turn-1'), 'utf8');
      const text = await readFile(store.providerContextTextPath('agent-1', 'turn-1'), 'utf8');
      const index = JSON.parse(json);
      expect(text).toContain(JSON.stringify(index, null, 2));
      expect(index).toMatchObject({
        schemaVersion: 1,
        contextStage: 'provider-payload',
        compaction: 'disabled',
        runtimeIdentity: {
          appVersion: '0.1.0-test',
          protocolVersion: 3,
          sessionRevision: 7,
          workerEpoch: 2,
        },
        calls: [
          { index: 1, jsonFile: 'call-000.json', textFile: 'call-000.txt' },
          { index: 2, jsonFile: 'call-001.json', textFile: 'call-001.txt' },
        ],
      });
      const contextDir = dirname(store.providerContextJsonPath('agent-1', 'turn-1'));
      const firstCall = await readFile(join(contextDir, 'call-000.json'), 'utf8');
      await expect(readFile(join(contextDir, 'call-000.txt'), 'utf8')).resolves.toContain('Provider call 1');
      expect(index.calls[0].sha256).toBe(createHash('sha256').update(firstCall).digest('hex'));
      expect(text).toContain('"instructions": "system prompt"');
      expect(text).toContain('"content": "previous request"');
      expect(text).toContain('"content": "stopped partial"');
      expect(text).toContain('"content": "continue"');
      expect(text).toContain('"name": "read"');
      expect(text).toContain('"content": "result"');
      await expect(store.appendProviderContext('agent-1', 'turn-1', 'request-1', {
        index: 4,
        capturedAt: 30,
        provider: 'openai',
        model: 'gpt-test',
        api: 'openai-responses',
        payload: {},
      })).rejects.toThrow(/in order/);
      store.destroy();
    } finally {
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });

  it('deletes assembled input and provider context for an undone turn', async () => {
    const dataDir = await createTempDataDir('iris-agent-context-delete-');
    const projectRoot = await createTempDataDir('iris-agent-context-delete-project-');
    try {
      const store = await IrisAgentSessionStore.load({ userDataPath: dataDir, projectRoot, debounceMs: 0 });
      await store.savePromptSnapshot('agent-1', 'turn-1', 'assembled input');
      await store.appendProviderContext('agent-1', 'turn-1', 'request-1', {
        index: 1,
        capturedAt: 10,
        provider: 'openai',
        model: 'gpt-test',
        api: 'openai-responses',
        payload: { model: 'gpt-test', input: [] },
      });

      await store.deleteTurnArtifacts('agent-1', 'turn-1');
      await expect(readFile(store.promptSnapshotPath('agent-1', 'turn-1'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(store.providerContextJsonPath('agent-1', 'turn-1'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      store.destroy();
    } finally {
      await removeTempDataDir(dataDir);
      await removeTempDataDir(projectRoot);
    }
  });

  it('allowlists provider payload fields and removes known secrets before persistence', () => {
    const secret = 'sk-super-secret';
    const payload = sanitizeProviderPayload({
      model: 'gpt-test',
      input: [{ role: 'user', content: `use ${secret}` }],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      headers: { authorization: `Bearer ${secret}` },
      credential: secret,
      providerExtension: { unsafe: secret },
    }, [secret]);
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('providerExtension');
    expect(serialized).toContain('tools');
  });
});
