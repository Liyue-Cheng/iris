import { access, appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

function aggregate(projectRoot: string) {
  return createEmptyAgentSession({
    id: 'session-1',
    anchor: { kind: 'workspace', path: '.iris' },
    model: { provider: 'openai', modelId: 'gpt-test' },
    projectRoot,
    displayName: 'Iris Agent',
    now: 1,
  });
}

describe('IrisAgentSessionStore v2', () => {
  it('removes legacy Agent roots once and preserves provider profiles', async () => {
    const userData = await createTempDataDir('iris-agent-v2-reset-');
    try {
      await mkdir(join(userData, 'iris-agent-sessions'), { recursive: true });
      await mkdir(join(userData, 'iris-agent-output'), { recursive: true });
      await mkdir(agentV2Root(userData), { recursive: true });
      await writeFile(join(userData, 'iris-agent-sessions', 'old.json'), '{}');
      await writeFile(join(userData, 'iris-agent-output', 'old.log'), 'old');
      await writeFile(join(agentV2Root(userData), 'old.json'), '{}');
      await writeFile(join(userData, 'iris-agent-provider-profiles.json'), '{"profiles":[]}');

      await resetLegacyIrisAgentData(userData);

      await expect(access(join(userData, 'iris-agent-sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(userData, 'iris-agent-output'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(agentV2Root(userData))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(userData, 'iris-agent-provider-profiles.json'), 'utf8')).toContain('profiles');
      expect(await readFile(join(agentV3Root(userData), 'manifest.json'), 'utf8')).toContain('iris-agent-v2');
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('commits a durable snapshot and hash-chained journal before restart recovery', async () => {
    const userData = await createTempDataDir('iris-agent-v2-store-');
    const projectRoot = join(userData, 'project');
    try {
      const store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const first = await store.commit(aggregate(projectRoot));
      first.displayName = 'Changed';
      const second = await store.commit(first);
      expect(second.revision).toBe(2);

      const indexPath = agentSessionStorePath(userData, projectRoot);
      const index = JSON.parse(await readFile(indexPath, 'utf8')) as { sessionIds: string[] };
      expect(index.sessionIds).toEqual(['session-1']);
      const sessionsDir = join(dirname(indexPath), 'sessions');
      const [sessionDir] = await readdir(sessionsDir);
      const journalRecords = (await readFile(join(sessionsDir, sessionDir!, 'journal.ndjson'), 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(journalRecords[1]).not.toHaveProperty('session');
      expect(journalRecords[1]).toHaveProperty('transaction.events');
      await rm(join(sessionsDir, sessionDir!, 'snapshot.json'));
      const reloaded = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      expect(reloaded.get('session-1')).toMatchObject({ displayName: 'Changed', revision: 2 });
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('ignores only a half-written journal tail and rejects a complete corrupted record', async () => {
    const userData = await createTempDataDir('iris-agent-v2-journal-');
    const projectRoot = join(userData, 'project');
    try {
      let store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      await store.commit(aggregate(projectRoot));
      const sessionsDir = join(dirname(agentSessionStorePath(userData, projectRoot)), 'sessions');
      const [sessionDir] = await readdir(sessionsDir);
      const journal = join(sessionsDir, sessionDir!, 'journal.ndjson');
      await appendFile(journal, '{"partial":');
      store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      expect(store.get('session-1')?.revision).toBe(1);
      await appendFile(journal, 'false}\n');
      await expect(IrisAgentSessionStore.load({ userDataPath: userData, projectRoot })).rejects.toThrow(
        /invalid record|malformed record/,
      );
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('recovers an interrupted Turn as paused without inventing a Reply', async () => {
    const userData = await createTempDataDir('iris-agent-v2-recover-');
    const projectRoot = join(userData, 'project');
    try {
      let store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      session.state = 'running';
      session.currentTurnId = 'turn-1';
      session.turns.push({
        id: 'turn-1', userActivityId: 'user-1', state: 'running',
        assembledInputAvailable: true, createdAt: 2,
      });
      session.timeline.push({
        kind: 'user', id: 'user-1', ordinal: 1, turnId: 'turn-1', content: 'hello',
        assembledInputArtifactId: 'input-1', createdAt: 2,
      });
      session.nextOrdinal = 2;
      await store.commit(session);
      store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const recovered = store.get('session-1')!;
      expect(recovered.state).toBe('paused');
      expect(recovered.turns[0]).toMatchObject({ state: 'paused', pauseReason: 'restart' });
      expect(recovered.timeline.map((activity) => activity.kind)).toEqual(['user']);
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('builds Worker history only from committed Transcript frames', async () => {
    const userData = await createTempDataDir('iris-agent-v2-history-');
    const projectRoot = join(userData, 'project');
    try {
      const store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      session.turns.push({
        id: 'turn-1', userActivityId: 'user-1', state: 'fulfilled',
        assembledInputAvailable: true, createdAt: 1, closedAt: 2,
      });
      session.providerCalls.push({
        id: 'call-1', turnId: 'turn-1', index: 1, state: 'completed',
        attemptIds: ['attempt-0'], createdAt: 1, completedAt: 2,
      });
      session.providerAttempts.push({
        id: 'attempt-0', providerCallId: 'call-1', turnId: 'turn-1', index: 1,
        state: 'failed', createdAt: 1, completedAt: 2,
      });
      session.transcript.push({
        id: 'provider-1', turnId: 'turn-1', providerCallId: 'call-1',
        role: 'assistant', content: 'committed answer', createdAt: 2,
      });
      session.timeline.push({
        kind: 'user', id: 'user-1', ordinal: 1, turnId: 'turn-1', content: 'hello',
        assembledInputArtifactId: 'input-1', createdAt: 1,
      }, {
        kind: 'reply', id: 'excluded', ordinal: 2, turnId: 'turn-1',
        providerCallId: 'call-1', providerAttemptId: 'attempt-0', providerMessageId: 'failed-1',
        state: 'failed', contextDisposition: 'excluded', content: 'failed draft', createdAt: 1,
      });
      session.nextOrdinal = 3;
      await store.commit(session);
      expect(store.history('session-1').messages.map((message) => message.content)).toEqual(['committed answer']);
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('rejects mutation of a terminal Reply at the Store boundary', async () => {
    const userData = await createTempDataDir('iris-agent-v2-terminal-');
    const projectRoot = join(userData, 'project');
    try {
      const store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      session.turns.push({
        id: 'turn-1', userActivityId: 'user-1', state: 'fulfilled',
        assembledInputAvailable: true, createdAt: 1, closedAt: 2,
      });
      session.providerCalls.push({
        id: 'call-1', turnId: 'turn-1', index: 1, state: 'completed',
        attemptIds: ['attempt-1'], createdAt: 1, completedAt: 2,
      });
      session.providerAttempts.push({
        id: 'attempt-1', providerCallId: 'call-1', turnId: 'turn-1', index: 1,
        state: 'completed', createdAt: 1, completedAt: 2,
      });
      session.timeline.push({
        kind: 'user', id: 'user-1', ordinal: 1, turnId: 'turn-1', content: 'hello',
        assembledInputArtifactId: 'input-1', createdAt: 1,
      }, {
        kind: 'reply', id: 'reply-1', ordinal: 2, turnId: 'turn-1',
        providerCallId: 'call-1', providerAttemptId: 'attempt-1', providerMessageId: 'message-1',
        state: 'completed', contextDisposition: 'committed', content: 'final', createdAt: 1, completedAt: 2,
      });
      session.nextOrdinal = 3;
      const saved = await store.commit(session);
      (saved.timeline[1] as { content: string }).content = 'rewritten';
      await expect(store.commit(saved)).rejects.toThrow(/immutable/);
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('recovers a file Effect when the process stopped after the write but before ledger settlement', async () => {
    const userData = await createTempDataDir('iris-agent-v2-effect-recovery-');
    const projectRoot = join(userData, 'project');
    const target = join(projectRoot, 'value.txt');
    try {
      await mkdir(projectRoot, { recursive: true });
      let store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      session.state = 'waiting-tool';
      session.currentTurnId = 'turn-1';
      session.turns.push({
        id: 'turn-1', userActivityId: 'user-1', state: 'running',
        assembledInputAvailable: true, createdAt: 1,
      });
      session.providerCalls.push({
        id: 'call-1', turnId: 'turn-1', index: 1, state: 'running',
        attemptIds: ['attempt-1'], createdAt: 1,
      });
      session.providerAttempts.push({
        id: 'attempt-1', providerCallId: 'call-1', turnId: 'turn-1', index: 1,
        state: 'running', createdAt: 1,
      });
      session.timeline.push(
        {
          kind: 'user', id: 'user-1', ordinal: 1, turnId: 'turn-1', content: 'write',
          assembledInputArtifactId: 'input-1', createdAt: 1,
        },
        {
          kind: 'tool', id: 'tool-1', ordinal: 2, turnId: 'turn-1',
          providerCallId: 'call-1', toolCallId: 'tool-1',
          tool: 'write', state: 'running', inputSummary: 'write value.txt', operation: 'writeFile',
          effectIds: [], createdAt: 2,
        },
      );
      session.toolOperations.push({
        id: 'operation-1', toolActivityId: 'tool-1', turnId: 'turn-1',
        input: { tool: 'write', operation: 'writeFile', absolutePath: target, content: 'after' },
        state: 'running', createdAt: 2,
      });
      session.nextOrdinal = 3;
      await store.commit(session);
      const sessionsDir = join(dirname(agentSessionStorePath(userData, projectRoot)), 'sessions');
      const [sessionDir] = await readdir(sessionsDir);
      const artifactDir = join(sessionsDir, sessionDir!, 'artifacts', 'effects');
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, 'file--operation-1.json'), JSON.stringify({
        path: 'value.txt', operation: 'write', beforeSha256: null,
        afterSha256: 'f39592393ef0859cb196a52693d2cea00fb2df784b3c04ae54aa7cadb8e562f8',
      }));
      await writeFile(target, 'after');

      store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      expect(store.get('session-1')?.effects).toContainEqual(expect.objectContaining({
        id: 'file--operation-1', kind: 'file-write', path: 'value.txt',
      }));
    } finally {
      await removeTempDataDir(userData);
    }
  });
});
