import { access, appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDataDir, removeTempDataDir } from '../persistence';
import { createEmptyAgentSession } from './session-model';
import {
  IrisAgentSessionStore,
  agentSessionStorePath,
  agentV2Root,
  agentV3Root,
  resetLegacyIrisAgentData,
} from './session-store';
const injection = {
  methods: { agent: 'current' as const, software: 'current' as const, project: 'current' as const },
  anchor: { path: '.iris', baselineText: '', baselineSha256: '', capturedAt: 1 },
};

function aggregate(projectRoot: string) {
  return createEmptyAgentSession({
    id: 'session-1',
    anchor: { kind: 'workspace', path: '.iris' },
    model: { provider: 'openai', modelId: 'gpt-test' },
    projectRoot,
    displayName: 'Iris Agent',
    injection,
    now: 1,
  });
}
function addExecution(session: ReturnType<typeof aggregate>, state: 'running' | 'completed' = 'completed') {
  session.activeIntentIds = ['intent-1'];
  session.currentIntentId = state === 'running' ? 'intent-1' : null;
  session.state = state === 'running' ? 'running' : 'idle';
  session.intents.push({
    id: 'intent-1', content: 'write it', turnIds: ['turn-1'],
    state: state === 'running' ? 'running' : 'completed',
    assembledInputAvailable: true, createdAt: 2,
    ...(state === 'completed' ? { closedAt: 4 } : {}),
  });
  session.turns.push({
    id: 'turn-1', intentId: 'intent-1', invokeId: 'invoke-1',
    state: state === 'running' ? 'running' : 'settled',
    assistant: { content: '', toolCalls: [{ id: 'tool-1', tool: 'write', input: {} }], createdAt: 2 },
    toolResults: state === 'completed'
      ? [{ toolCallId: 'tool-1', tool: 'write', content: 'ok', isError: false, createdAt: 3 }]
      : [],
    createdAt: 2,
    ...(state === 'completed' ? { settledAt: 4 } : {}),
  });
  session.invokes.push({
    id: 'invoke-1', intentId: 'intent-1', turnId: 'turn-1', index: 1,
    state, attemptIds: ['attempt-1'], createdAt: 2,
    ...(state === 'completed' ? { completedAt: 4 } : {}),
  });
  session.invokeAttempts.push({
    id: 'attempt-1', invokeId: 'invoke-1', intentId: 'intent-1', turnId: 'turn-1',
    index: 1, state, createdAt: 2,
    ...(state === 'completed' ? { completedAt: 4 } : {}),
  });
}

describe('IrisAgentSessionStore', () => {
  it('removes pre-journal Agent roots once and preserves provider profiles', async () => {
    const userData = await createTempDataDir('iris-agent-reset-');
    try {
      await mkdir(join(userData, 'iris-agent-sessions'), { recursive: true });
      await mkdir(join(userData, 'iris-agent-output'), { recursive: true });
      await mkdir(agentV2Root(userData), { recursive: true });
      await mkdir(agentV3Root(userData), { recursive: true });
      await writeFile(join(agentV3Root(userData), 'stale-session.marker'), 'old agent data');
      await writeFile(join(userData, 'iris-agent-sessions', 'old.json'), '{}');
      await writeFile(join(userData, 'iris-agent-provider-profiles.json'), '{"profiles":[]}');
      await resetLegacyIrisAgentData(userData);
      await expect(access(join(userData, 'iris-agent-sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(userData, 'iris-agent-output'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(agentV2Root(userData))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(agentV3Root(userData), 'stale-session.marker'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(userData, 'iris-agent-provider-profiles.json'), 'utf8')).toContain('profiles');
      expect(JSON.parse(await readFile(join(agentV3Root(userData), 'manifest.json'), 'utf8'))).toMatchObject({
        version: 2,
        legacyResetCompleted: true,
      });
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('resets v3 data once when upgrading from the previous store manifest', async () => {
    const userData = await createTempDataDir('iris-agent-reset-upgrade-');
    try {
      const root = agentV3Root(userData);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'manifest.json'), JSON.stringify({
        version: 1,
        legacyResetCompleted: true,
      }));
      await writeFile(join(root, 'stale-session.marker'), 'old agent data');

      await resetLegacyIrisAgentData(userData);

      await expect(access(join(root, 'stale-session.marker'))).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(join(root, 'new-session.marker'), 'new agent data');
      await resetLegacyIrisAgentData(userData);
      expect(await readFile(join(root, 'new-session.marker'), 'utf8')).toBe('new agent data');
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('replays a hash-chained journal and ignores only a partial tail', async () => {
    const userData = await createTempDataDir('iris-agent-journal-');
    const projectRoot = join(userData, 'project');
    try {
      let store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const first = await store.commit(aggregate(projectRoot));
      first.displayName = 'Changed';
      await store.commit(first);
      const sessionsDir = join(dirname(agentSessionStorePath(userData, projectRoot)), 'sessions');
      const [sessionDir] = await readdir(sessionsDir);
      const journal = join(sessionsDir, sessionDir!, 'journal.ndjson');
      await rm(join(sessionsDir, sessionDir!, 'snapshot.json'));
      await appendFile(journal, '{"partial":');
      store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      expect(store.get('session-1')).toMatchObject({ displayName: 'Changed', revision: 2 });
      await appendFile(journal, 'false}\n');
      await expect(IrisAgentSessionStore.load({ userDataPath: userData, projectRoot }))
        .rejects.toThrow(/invalid record|malformed record/);
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('recovers an interrupted execution as a paused Intent and settled Turn', async () => {
    const userData = await createTempDataDir('iris-agent-recover-');
    const projectRoot = join(userData, 'project');
    try {
      let store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      addExecution(session, 'running');
      await store.commit(session);
      store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const recovered = store.get('session-1')!;
      expect(recovered.state).toBe('paused');
      expect(recovered.intents[0]).toMatchObject({
        state: 'paused', pauseReason: 'restart', pauseMessage: expect.stringContaining('restarted'),
      });
      expect(recovered.turns[0]).toMatchObject({ state: 'settled' });
      expect(recovered.invokes[0]).toMatchObject({ state: 'holding' });
      expect(recovered.invokeAttempts[0]).toMatchObject({ state: 'aborted' });
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('builds Worker history from Intent and provider-neutral Turn facts', async () => {
    const userData = await createTempDataDir('iris-agent-history-');
    const projectRoot = join(userData, 'project');
    try {
      const store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      addExecution(session);
      session.turns[0]!.assistant = { content: 'committed answer', toolCalls: [], createdAt: 3 };
      session.turns[0]!.toolResults = [];
      await store.commit(session);
      expect(store.history('session-1').messages.map((message) => message.content))
        .toEqual(['write it', 'committed answer']);
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('moves legacy Turn artifact directories to Intent ownership on load', async () => {
    const userData = await createTempDataDir('iris-agent-artifact-migration-');
    const projectRoot = join(userData, 'project');
    try {
      let store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      addExecution(session);
      await store.commit(session);
      const sessionsDir = join(dirname(agentSessionStorePath(userData, projectRoot)), 'sessions');
      const [sessionDir] = await readdir(sessionsDir);
      const artifactKey = digest('intent-1').slice(0, 32);
      const legacyDir = join(sessionsDir, sessionDir!, 'artifacts', 'turns', artifactKey);
      await mkdir(legacyDir, { recursive: true });
      await writeFile(join(legacyDir, 'assembled-input.txt'), 'legacy prompt');

      store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });

      expect(await readFile(store.promptSnapshotPath('session-1', 'intent-1'), 'utf8'))
        .toBe('legacy prompt');
      await expect(access(legacyDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('does not inspect the filesystem during a Trace rewind', async () => {
    const userData = await createTempDataDir('iris-agent-rewind-conflict-');
    const projectRoot = join(userData, 'project');
    const target = join(projectRoot, 'value.txt');
    try {
      await mkdir(projectRoot, { recursive: true });
      await writeFile(target, 'user change');
      const store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      addExecution(session);
      session.timeline.push({
        kind: 'tool', id: 'tool-1', ordinal: 1, intentId: 'intent-1', turnId: 'turn-1',
        invokeId: 'invoke-1', toolCallId: 'tool-1', tool: 'write', state: 'completed',
        inputSummary: 'write value.txt', operation: 'writeFile',
        createdAt: 2, completedAt: 3,
      });
      session.nextOrdinal = 2;
      await store.commit(session);
      expect(await readFile(target, 'utf8')).toBe('user change');
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('routes every v2 journal record through the isolated migration boundary', async () => {
    const userData = await createTempDataDir('iris-agent-v2-migration-');
    const projectRoot = join(userData, 'project');
    try {
      await resetLegacyIrisAgentData(userData);
      const sessionDir = join(
        dirname(agentSessionStorePath(userData, projectRoot)),
        'sessions',
        digest('legacy-session').slice(0, 32),
      );
      await mkdir(sessionDir, { recursive: true });
      const legacy = {
        id: 'legacy-session', kind: 'iris-agent', anchor: { kind: 'workspace', path: '.iris' },
        model: { provider: 'openai', modelId: 'test' }, projectRoot,
        displayName: 'Before scalar update', state: 'idle', revision: 1, workerEpoch: 0,
        nextOrdinal: 2, currentTurnId: null, createdAt: 1, updatedAt: 1, selfHostingEligible: false,
        turns: [{
          id: 'A', userActivityId: 'uA', state: 'fulfilled',
          assembledInputAvailable: true, createdAt: 1,
        }],
        intents: [], providerCalls: [], providerAttempts: [],
        timeline: [{
          id: 'uA', ordinal: 1, turnId: 'A', kind: 'user', content: 'A',
          assembledInputArtifactId: 'A', createdAt: 1,
        }],
        toolOperations: [], transcript: [], requestFacts: [], undoReceipts: [],
        effectiveTraceLength: 1,
      };
      const firstInput = {
        version: 2, revision: 1, previousHash: '', committedAt: 1,
        transaction: { events: [{ type: 'session.created', session: legacy }] },
      };
      const first = { ...firstInput, journalHash: digest(JSON.stringify(firstInput)) };
      const secondInput = {
        version: 2, revision: 2, previousHash: first.journalHash, committedAt: 2,
        transaction: {
          events: [{
            type: 'session.updated',
            patch: { revision: 2, displayName: 'After scalar update', updatedAt: 2 },
            removedKeys: [],
          }],
        },
      };
      const second = { ...secondInput, journalHash: digest(JSON.stringify(secondInput)) };
      await writeFile(
        join(sessionDir, 'journal.ndjson'),
        JSON.stringify(first) + '\n' + JSON.stringify(second) + '\n',
      );

      const store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const migrated = store.get('legacy-session')!;
      expect(migrated).toMatchObject({
        revision: 2, displayName: 'After scalar update', activeIntentIds: ['A'],
      });
      expect(migrated).not.toHaveProperty('transcript');
      const snapshot = JSON.parse(await readFile(join(sessionDir, 'snapshot.json'), 'utf8')) as {
        version: number;
      };
      expect(snapshot.version).toBe(3);
    } finally {
      await removeTempDataDir(userData);
    }
  });
});

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
