import { access, appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDataDir, removeTempDataDir } from '../persistence';
import { createEmptyAgentSession } from './session-model';
import { closeAgentSession, reopenAgentSession } from './session-domain';
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
      expect((await store.history('session-1')).messages.map((message) => message.content))
        .toEqual(['write it', 'committed answer']);
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('stores an Agent image once and re-projects it into history with its bytes', async () => {
    const userData = await createTempDataDir('iris-agent-attachment-');
    const projectRoot = join(userData, 'project');
    try {
      const store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      addExecution(session);
      session.turns[0]!.assistant = {
        content: '', toolCalls: [{ id: 'tool-1', tool: 'read', input: { path: 'shot.png' } }], createdAt: 2,
      };
      session.turns[0]!.toolResults = [];
      await store.commit(session);

      const bytes = Buffer.from('fake png bytes');
      const attachment = await store.saveAttachment('session-1', {
        name: 'shot.png', mimeType: 'image/png', bytes, width: 4, height: 4,
      });
      expect(attachment.id).toBe(digest('fake png bytes'));
      expect(attachment).toMatchObject({
        name: 'shot.png', bytes: bytes.byteLength, width: 4, height: 4,
      });

      // Identical bytes are one file, which is what makes a repeated read free.
      const duplicate = await store.saveAttachment('session-1', {
        name: 'copy.png', mimeType: 'image/png', bytes,
      });
      expect(duplicate.id).toBe(attachment.id);
      const attachmentDir = join(
        dirname(agentSessionStorePath(userData, projectRoot)),
        'sessions',
        digest('session-1').slice(0, 32),
        'artifacts',
        'attachments',
      );
      expect(await readdir(attachmentDir)).toEqual([`${attachment.id}.png`]);

      // Failed-send cleanup removes only unreachable bytes. A duplicate upload
      // of an image already owned by history must keep the shared file.
      const latestWithReference = store.get('session-1')!;
      latestWithReference.intents[0]!.attachments = [attachment];
      await store.commit(latestWithReference);
      await store.removeAttachmentsIfUnreferenced('session-1', [duplicate]);
      await expect(store.readAttachment('session-1', attachment)).resolves.toEqual(bytes);
      delete latestWithReference.intents[0]!.attachments;
      await store.commit(latestWithReference);

      const orphanBytes = Buffer.from('other fake png bytes');
      const orphan = await store.saveAttachment('session-1', {
        name: 'orphan.png', mimeType: 'image/png', bytes: orphanBytes,
      });
      await store.removeAttachmentsIfUnreferenced('session-1', [orphan]);
      await expect(store.readAttachment('session-1', orphan)).rejects.toMatchObject({ code: 'ENOENT' });

      const latest = store.get('session-1')!;
      latest.turns[0]!.assistant = {
        content: 'I looked at the screenshot.',
        toolCalls: [{ id: 'tool-1', tool: 'read', input: { path: 'shot.png' } }],
        createdAt: 3,
      };
      latest.turns[0]!.toolResults = [{
        toolCallId: 'tool-1', tool: 'read', content: 'shot.png: image image/png 4x4.',
        attachments: [attachment], isError: false, createdAt: 3,
      }];
      await store.commit(latest);

      const history = await store.history('session-1');
      const toolMessage = history.messages.find((message) => message.role === 'tool')!;
      expect(toolMessage.attachments).toEqual([attachment]);
      expect(toolMessage.content).toEqual([
        { type: 'text', text: 'shot.png: image image/png 4x4.' },
        {
          type: 'image',
          attachment,
          dataBase64: bytes.toString('base64'),
        },
      ]);
      // A text-only projection stays a string, so nothing else changes shape.
      expect(history.messages.find((message) => message.role === 'user')?.content).toBe('write it');
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('keeps the text of a tool result whose attachment file is gone', async () => {
    const userData = await createTempDataDir('iris-agent-attachment-missing-');
    const projectRoot = join(userData, 'project');
    try {
      const store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      addExecution(session);
      await store.commit(session);
      const attachment = await store.saveAttachment('session-1', {
        name: 'shot.png', mimeType: 'image/png', bytes: Buffer.from('png'),
      });
      const attachmentDir = join(
        dirname(agentSessionStorePath(userData, projectRoot)),
        'sessions',
        digest('session-1').slice(0, 32),
        'artifacts',
        'attachments',
      );
      await rm(join(attachmentDir, `${attachment.id}.png`));

      const latest = store.get('session-1')!;
      latest.turns[0]!.assistant = {
        content: '', toolCalls: [{ id: 'tool-1', tool: 'read', input: { path: 'shot.png' } }], createdAt: 2,
      };
      latest.turns[0]!.toolResults = [{
        toolCallId: 'tool-1', tool: 'read', content: 'image was here',
        attachments: [attachment], isError: false, createdAt: 3,
      }];
      await store.commit(latest);

      const toolMessage = (await store.history('session-1')).messages
        .find((message) => message.role === 'tool')!;
      // A missing file must never become a fabricated image block.
      expect(toolMessage.content).toBe('image was here');
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('refuses an attachment descriptor that is not content-addressed', async () => {
    const userData = await createTempDataDir('iris-agent-attachment-guard-');
    const projectRoot = join(userData, 'project');
    try {
      const store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      await store.commit(aggregate(projectRoot));
      await expect(store.saveAttachment('session-1', {
        name: 'x.png', mimeType: 'image/png', bytes: Buffer.alloc(0),
      })).rejects.toThrow(/empty/);
      await expect(store.readAttachment('session-1', {
        id: '../../etc/passwd', name: 'x', mimeType: 'image/png', bytes: 1,
      })).rejects.toThrow(/identity is invalid/);
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

  it('keeps a closed Session out of the live list and lists it as history metadata', async () => {
    const userData = await createTempDataDir('iris-agent-archived-');
    const projectRoot = join(userData, 'project');
    try {
      let store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      addExecution(session);
      await store.commit(session);
      await store.commit(closeAgentSession(store.get('session-1')!));

      store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });

      // The closed instance is no longer live...
      expect(store.list()).toHaveLength(0);
      expect(store.get('session-1')).toBeNull();
      // ...but it is still listed, with metadata, for its anchor.
      const history = store.historyEntries({ kind: 'workspace', path: '.iris' });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        id: 'session-1', closed: true, intentCount: 1, lastUserMessage: 'write it',
      });
      expect(store.historyEntries({ kind: 'document', path: 'doc.md' })).toHaveLength(0);

      // Switching back in validates and replays the journal exactly once.
      const restored = await store.ensureLoaded('session-1');
      expect(restored).toMatchObject({ id: 'session-1', closedAt: expect.any(Number) });
      expect((await store.ensureLoaded('session-1'))?.id).toBe('session-1');
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('does not replay a closed Session journal at startup', async () => {
    const userData = await createTempDataDir('iris-agent-archived-corrupt-');
    const projectRoot = join(userData, 'project');
    try {
      let store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      addExecution(session);
      await store.commit(session);
      await store.commit(closeAgentSession(store.get('session-1')!));
      const sessionsDir = join(dirname(agentSessionStorePath(userData, projectRoot)), 'sessions');
      const [sessionDir] = await readdir(sessionsDir);
      // A malformed record before the tail would fail a normal load. The
      // snapshot is authoritative for a closed Session, so startup stays
      // intact; the damage only surfaces when the Session is reopened.
      await appendFile(join(sessionsDir, sessionDir!, 'journal.ndjson'), '{"broken":true}\n');

      store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      expect(store.list()).toHaveLength(0);
      expect(store.historyEntries({ kind: 'workspace', path: '.iris' })[0]?.closed).toBe(true);
      await expect(store.ensureLoaded('session-1')).rejects.toThrow(
        /hash chain is broken|revision sequence is broken|invalid record/,
      );
    } finally {
      await removeTempDataDir(userData);
    }
  });

  it('rejects a stale closed snapshot when the journal tail reopened the Session', async () => {
    const userData = await createTempDataDir('iris-agent-archived-stale-');
    const projectRoot = join(userData, 'project');
    try {
      let store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      const session = aggregate(projectRoot);
      addExecution(session);
      await store.commit(session);
      await store.commit(closeAgentSession(store.get('session-1')!));
      const sessionsDir = join(dirname(agentSessionStorePath(userData, projectRoot)), 'sessions');
      const [sessionDir] = await readdir(sessionsDir);
      const snapshotPath = join(sessionsDir, sessionDir!, 'snapshot.json');
      const staleClosedSnapshot = await readFile(snapshotPath, 'utf8');

      await store.ensureLoaded('session-1');
      await store.commit(reopenAgentSession(store.get('session-1')!));
      // Simulate a crash/failed atomic replacement after the reopen journal was
      // synced but before its new snapshot became durable.
      await writeFile(snapshotPath, staleClosedSnapshot);

      store = await IrisAgentSessionStore.load({ userDataPath: userData, projectRoot });
      expect(store.list()).toHaveLength(1);
      expect(store.get('session-1')?.id).toBe('session-1');
      expect(store.get('session-1')?.closedAt).toBeUndefined();
      expect(store.historyEntries({ kind: 'workspace', path: '.iris' })[0]?.closed).toBe(false);
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
