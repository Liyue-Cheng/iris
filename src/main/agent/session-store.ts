import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, truncate } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from '../atomic-write';
import type { AgentHistorySnapshot } from '@shared/agent-protocol';
import type {
  IrisAgentProviderContextBundle,
  IrisAgentProviderContextCall,
  ProjectScope,
} from '@shared/types';
import type { AgentSessionAggregate } from './session-model';
import { cloneAgentSession, isAgentSessionQuiescent } from './session-model';
import {
  applyAgentDomainTransaction,
  createAgentDomainTransaction,
  isAgentDomainTransaction,
  type AgentDomainTransaction,
} from './session-events';
import { isDeepStrictEqual } from 'node:util';
import {
  renderProviderContextCall,
  renderProviderContextIndex,
  sanitizeProviderContextCall,
} from './context-artifact';

export const IRIS_AGENT_SESSION_STORE_VERSION = 2 as const;
const STORE_MANIFEST_VERSION = 1 as const;
const resetPromises = new Map<string, Promise<void>>();

interface ProjectIndex {
  version: typeof IRIS_AGENT_SESSION_STORE_VERSION;
  projectRoot: string;
  sessionIds: string[];
}

interface SessionSnapshot {
  version: typeof IRIS_AGENT_SESSION_STORE_VERSION;
  revision: number;
  journalHash: string;
  session: AgentSessionAggregate;
}

interface JournalRecord {
  version: typeof IRIS_AGENT_SESSION_STORE_VERSION;
  revision: number;
  previousHash: string;
  journalHash: string;
  committedAt: number;
  transaction: AgentDomainTransaction;
}

export function agentV2Root(userDataPath: string): string {
  return join(resolve(userDataPath), 'iris-agent-v2');
}

export function agentV3Root(userDataPath: string): string {
  return join(resolve(userDataPath), 'iris-agent-v3');
}

export function agentSessionStorePath(userDataPath: string, projectRoot: string): string {
  return join(agentV3Root(userDataPath), 'projects', projectKey(projectRoot), 'index.json');
}

export async function resetLegacyIrisAgentData(userDataPath: string): Promise<void> {
  const resolvedUserData = resolve(userDataPath);
  const existing = resetPromises.get(resolvedUserData);
  if (existing) return existing;
  const pending = (async () => {
    const v3Root = agentV3Root(resolvedUserData);
    const manifest = join(v3Root, 'manifest.json');
    try {
      const parsed: unknown = JSON.parse(await readFile(manifest, 'utf8'));
      if (isRecord(parsed) && parsed.version === STORE_MANIFEST_VERSION && parsed.legacyResetCompleted === true) {
        return;
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const legacyTargets = ['iris-agent-sessions', 'iris-agent-output', 'iris-agent-v2'].map((name) => {
      const target = resolve(resolvedUserData, name);
      assertExactChild(resolvedUserData, target, name);
      return target;
    });
    for (const target of legacyTargets) await rm(target, { recursive: true, force: true });
    await mkdir(v3Root, { recursive: true });
    await writeFileAtomic(manifest, JSON.stringify({
      version: STORE_MANIFEST_VERSION,
      legacyResetCompleted: true,
      createdAt: Date.now(),
      removed: legacyTargets.map((target) => basename(target)),
    }, null, 2) + '\n');
  })();
  resetPromises.set(resolvedUserData, pending);
  try {
    await pending;
  } catch (error) {
    resetPromises.delete(resolvedUserData);
    throw error;
  }
}

export class IrisAgentSessionStore {
  private readonly sessions = new Map<string, AgentSessionAggregate>();
  private readonly journalHashes = new Map<string, string>();
  private index: ProjectIndex;

  private constructor(
    private readonly projectRoot: string,
    private readonly projectDir: string,
    index: ProjectIndex,
  ) {
    this.index = index;
  }

  static async load(options: {
    userDataPath: string;
    projectRoot: string;
    debounceMs?: number;
  }): Promise<IrisAgentSessionStore> {
    void options.debounceMs;
    await resetLegacyIrisAgentData(options.userDataPath);
    const projectDir = dirname(agentSessionStorePath(options.userDataPath, options.projectRoot));
    await mkdir(join(projectDir, 'sessions'), { recursive: true });
    const index = await readProjectIndex(join(projectDir, 'index.json'), options.projectRoot);
    const store = new IrisAgentSessionStore(
      options.projectRoot,
      projectDir,
      index,
    );
    const ids = new Set(index.sessionIds);
    for (const directory of await readdir(join(projectDir, 'sessions'), { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const sessionDir = join(projectDir, 'sessions', directory.name);
      const snapshot = await readSnapshot(join(sessionDir, 'snapshot.json'));
      const discoveredId = snapshot?.session.id ?? await discoverSessionId(join(sessionDir, 'journal.ndjson'));
      if (discoveredId && (!snapshot || snapshot.session.projectRoot === options.projectRoot)) ids.add(discoveredId);
    }
    for (const id of ids) {
      const loaded = await store.loadSession(id);
      if (!loaded) continue;
      store.sessions.set(id, loaded.session);
      store.journalHashes.set(id, loaded.journalHash);
    }
    store.index = {
      version: IRIS_AGENT_SESSION_STORE_VERSION,
      projectRoot: options.projectRoot,
      sessionIds: [...store.sessions.keys()],
    };
    await store.writeIndex();
    for (const session of [...store.sessions.values()]) {
      if (isInterrupted(session)) {
        await store.commit(await recoverInterrupted(session, store.sessionDir(session.id), options.projectRoot));
      }
    }
    return store;
  }

  list(_scope?: ProjectScope): AgentSessionAggregate[] {
    return [...this.sessions.values()].map(cloneAgentSession);
  }

  get(sessionId: string): AgentSessionAggregate | null {
    const session = this.sessions.get(sessionId);
    return session ? cloneAgentSession(session) : null;
  }

  async commit(source: AgentSessionAggregate): Promise<AgentSessionAggregate> {
    if (source.projectRoot !== this.projectRoot) {
      throw new Error('Iris Agent session is outside this store project.');
    }
    const previous = this.sessions.get(source.id);
    const now = Date.now();
    const session = cloneAgentSession(source);
    session.revision = previous ? previous.revision + 1 : Math.max(1, session.revision);
    session.updatedAt = Math.max(now, (previous?.updatedAt ?? 0) + 1);
    const transaction = createAgentDomainTransaction(previous ?? null, session);
    const replayed = applyAgentDomainTransaction(previous ?? null, transaction);
    if (!isDeepStrictEqual(replayed, session)) {
      throw new Error('Iris Agent domain transaction did not reproduce the committed aggregate.');
    }
    const previousHash = this.journalHashes.get(session.id) ?? '';
    const committedAt = now;
    const hash = journalHash({
      version: IRIS_AGENT_SESSION_STORE_VERSION,
      revision: session.revision,
      previousHash,
      committedAt,
      transaction,
    });
    const record: JournalRecord = {
      version: IRIS_AGENT_SESSION_STORE_VERSION,
      revision: session.revision,
      previousHash,
      journalHash: hash,
      committedAt,
      transaction,
    };
    const directory = this.sessionDir(session.id);
    await mkdir(directory, { recursive: true });
    const journal = await open(join(directory, 'journal.ndjson'), 'a');
    try {
      await journal.writeFile(JSON.stringify(record) + '\n', 'utf8');
      await journal.sync();
    } finally {
      await journal.close();
    }
    const isNew = !previous;
    this.sessions.set(session.id, session);
    this.journalHashes.set(session.id, hash);
    if (isNew) {
      this.index = { ...this.index, sessionIds: [...this.index.sessionIds, session.id] };
    }
    if (isAgentSessionQuiescent(session)) {
      await writeFileAtomic(join(directory, 'snapshot.json'), JSON.stringify({
        version: IRIS_AGENT_SESSION_STORE_VERSION,
        revision: session.revision,
        journalHash: hash,
        session,
      } satisfies SessionSnapshot, null, 2) + '\n').catch(() => undefined);
    }
    if (isNew) await this.writeIndex().catch(() => undefined);
    return cloneAgentSession(session);
  }

  async delete(sessionId: string): Promise<void> {
    const directory = this.sessionDir(sessionId);
    assertInside(this.projectDir, directory);
    await rm(directory, { recursive: true, force: true });
    this.sessions.delete(sessionId);
    this.journalHashes.delete(sessionId);
    this.index = {
      ...this.index,
      sessionIds: this.index.sessionIds.filter((candidate) => candidate !== sessionId),
    };
    await this.writeIndex();
  }

  async savePromptSnapshot(sessionId: string, turnId: string, prompt: string): Promise<void> {
    await writeFileAtomic(this.promptSnapshotPath(sessionId, turnId), prompt);
  }

  promptSnapshotPath(sessionId: string, turnId: string): string {
    return join(this.turnArtifactDir(sessionId, turnId), 'assembled-input.txt');
  }

  artifactRoot(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'artifacts');
  }

  async appendProviderContext(
    sessionId: string,
    turnId: string,
    call: IrisAgentProviderContextCall,
    assembledInputAvailable = true,
    runtimeIdentity?: NonNullable<IrisAgentProviderContextBundle['runtimeIdentity']>,
  ): Promise<IrisAgentProviderContextBundle> {
    const existing = await this.readProviderContextBundle(sessionId, turnId);
    const sanitized = sanitizeProviderContextCall(call);
    const calls = existing?.calls ?? [];
    const duplicate = calls.find((candidate) => candidate.index === sanitized.index);
    if (duplicate) return existing!;
    const callBase = `call-${String(calls.length).padStart(3, '0')}`;
    const jsonFile = callBase + '.json';
    const textFile = callBase + '.txt';
    const callJson = JSON.stringify(sanitized, null, 2) + '\n';
    const bundle: IrisAgentProviderContextBundle = {
      schemaVersion: 2,
      kind: 'provider-context-bundle',
      sessionId,
      turnId,
      createdAt: existing?.createdAt ?? sanitized.capturedAt,
      assembledInput: { available: assembledInputAvailable },
      contextStage: 'provider-payload',
      compaction: 'disabled',
      ...(runtimeIdentity ?? existing?.runtimeIdentity
        ? { runtimeIdentity: runtimeIdentity ?? existing!.runtimeIdentity }
        : {}),
      calls: [...calls, {
        index: sanitized.index,
        capturedAt: sanitized.capturedAt,
        provider: sanitized.provider,
        model: sanitized.model,
        api: sanitized.api,
        jsonFile,
        textFile,
        sha256: sha256(callJson),
      }],
    };
    const contextDir = this.providerContextDir(sessionId, turnId);
    await writeFileAtomic(join(contextDir, jsonFile), callJson);
    await writeFileAtomic(join(contextDir, textFile), renderProviderContextCall(sanitized));
    await writeFileAtomic(this.providerContextJsonPath(sessionId, turnId), JSON.stringify(bundle, null, 2) + '\n');
    await this.refreshProviderContextText(sessionId, turnId).catch(() => undefined);
    return bundle;
  }

  providerContextTextPath(sessionId: string, turnId: string): string {
    return join(this.providerContextDir(sessionId, turnId), 'index.txt');
  }

  async refreshProviderContextText(sessionId: string, turnId: string): Promise<void> {
    const bundle = await this.readProviderContextBundle(sessionId, turnId);
    if (!bundle) throw new Error('Provider context bundle is unavailable.');
    const calls = await this.loadIndexedProviderCalls(sessionId, turnId, bundle.calls);
    const attempts = this.sessions.get(sessionId)?.providerAttempts.filter(
      (attempt) => attempt.turnId === turnId,
    ) ?? [];
    await writeFileAtomic(
      this.providerContextTextPath(sessionId, turnId),
      renderProviderContextIndex(bundle, calls, attempts),
    );
  }

  history(sessionId: string): AgentHistorySnapshot {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('[IrisAgentSessionStore] unknown session ' + sessionId);
    const includedTurns = new Set(
      session.turns.filter((turn) => turn.state !== 'removed').map((turn) => turn.id),
    );
    return {
      revision: session.revision,
      anchor: { ...session.anchor },
      messages: session.transcript
        .filter((frame) => includedTurns.has(frame.turnId))
        .map((frame) => ({
          id: frame.id,
          turnId: frame.turnId,
          role: frame.role,
          content: frame.content,
          createdAt: frame.createdAt,
          ...(frame.providerMessage ? { providerMessage: structuredClone(frame.providerMessage) } : {}),
        })),
    };
  }

  async flush(): Promise<void> {}

  destroy(): void {}

  get root(): string {
    return this.projectRoot;
  }

  private async loadSession(sessionId: string): Promise<SessionSnapshot | null> {
    const directory = this.sessionDir(sessionId);
    const journalPath = join(directory, 'journal.ndjson');
    try {
      const rawJournal = await readFile(journalPath, 'utf8');
      const lines = rawJournal.split(/\r?\n/u).filter(Boolean);
      let previousHash = '';
      const records: JournalRecord[] = [];
      let partialTail = false;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch (error) {
          if (index === lines.length - 1 && !rawJournal.endsWith('\n')) {
            partialTail = true;
            break;
          }
          throw new Error('Iris Agent journal contains a malformed record before its tail.', { cause: error });
        }
        if (!isJournalRecord(value)) {
          throw new Error('Iris Agent journal contains an invalid record.');
        }
        if (value.previousHash !== previousHash) {
          throw new Error('Iris Agent journal hash chain is broken.');
        }
        if (value.revision !== records.length + 1) {
          throw new Error('Iris Agent journal revision sequence is broken.');
        }
        const expected = journalHash({
          version: value.version,
          revision: value.revision,
          previousHash: value.previousHash,
          committedAt: value.committedAt,
          transaction: value.transaction,
        });
        if (expected !== value.journalHash) {
          throw new Error('Iris Agent journal record hash is invalid.');
        }
        records.push(value);
        previousHash = value.journalHash;
      }
      if (partialTail) {
        const validPrefix = rawJournal.slice(0, rawJournal.lastIndexOf('\n') + 1);
        await truncate(journalPath, Buffer.byteLength(validPrefix, 'utf8'));
      }
      if (records.length > 0) {
        const snapshot = await readSnapshot(join(directory, 'snapshot.json'));
        let session: AgentSessionAggregate | null = null;
        let replayFrom = 0;
        if (snapshot) {
          const anchor = records[snapshot.revision - 1];
          if (!anchor || anchor.journalHash !== snapshot.journalHash) {
            throw new Error('Iris Agent snapshot is not anchored in its journal.');
          }
          session = cloneAgentSession(snapshot.session);
          replayFrom = snapshot.revision;
        }
        for (const record of records.slice(replayFrom)) {
          session = applyAgentDomainTransaction(session, record.transaction);
          if (session.revision !== record.revision) {
            throw new Error('Iris Agent journal transaction produced the wrong revision.');
          }
        }
        const latest = records[records.length - 1]!;
        if (session?.id !== sessionId || session.projectRoot !== this.projectRoot) return null;
        return {
          version: IRIS_AGENT_SESSION_STORE_VERSION,
          revision: latest.revision,
          journalHash: latest.journalHash,
          session: cloneAgentSession(session),
        };
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const snapshot = await readSnapshot(join(directory, 'snapshot.json'));
    return snapshot?.session.id === sessionId && snapshot.session.projectRoot === this.projectRoot
      ? snapshot
      : null;
  }

  private sessionDir(sessionId: string): string {
    return join(this.projectDir, 'sessions', sha256(sessionId).slice(0, 32));
  }

  private turnArtifactDir(sessionId: string, turnId: string): string {
    return join(this.sessionDir(sessionId), 'artifacts', 'turns', sha256(turnId).slice(0, 32));
  }

  private providerContextDir(sessionId: string, turnId: string): string {
    return join(this.turnArtifactDir(sessionId, turnId), 'provider-context');
  }

  private providerContextJsonPath(sessionId: string, turnId: string): string {
    return join(this.providerContextDir(sessionId, turnId), 'index.json');
  }

  private async readProviderContextBundle(
    sessionId: string,
    turnId: string,
  ): Promise<IrisAgentProviderContextBundle | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.providerContextJsonPath(sessionId, turnId), 'utf8'));
      return isProviderContextBundle(value) ? value : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async loadIndexedProviderCalls(
    sessionId: string,
    turnId: string,
    calls: IrisAgentProviderContextBundle['calls'],
  ): Promise<IrisAgentProviderContextCall[]> {
    return Promise.all(calls.map(async (indexed) => {
      const raw = await readFile(join(this.providerContextDir(sessionId, turnId), indexed.jsonFile), 'utf8');
      if (sha256(raw) !== indexed.sha256) throw new Error('Stored provider context call hash mismatch.');
      const value: unknown = JSON.parse(raw);
      if (!isProviderContextCall(value)) throw new Error('Stored provider context call is invalid.');
      return value;
    }));
  }

  private async writeIndex(): Promise<void> {
    await writeFileAtomic(join(this.projectDir, 'index.json'), JSON.stringify(this.index, null, 2) + '\n');
  }
}

async function recoverInterrupted(
  source: AgentSessionAggregate,
  sessionDir: string,
  projectRoot: string,
): Promise<AgentSessionAggregate> {
  const session = cloneAgentSession(source);
  const turn = session.turns.find((candidate) => candidate.id === session.currentTurnId);
  const now = Date.now();
  if (turn) {
    turn.state = 'paused';
    turn.pauseReason = 'restart';
    turn.error = 'Iris restarted before the Agent turn settled.';
    for (const activity of session.timeline) {
      if (activity.kind === 'reply' && activity.turnId === turn.id && activity.state === 'streaming') {
        activity.state = 'stopped';
        activity.contextDisposition = 'excluded';
        activity.completedAt = now;
      }
      if (activity.kind === 'tool' && activity.turnId === turn.id && activity.state === 'running') {
        activity.state = 'canceled';
        activity.completedAt = now;
      }
    }
    for (const operation of session.toolOperations) {
      if (operation.turnId === turn.id && operation.state === 'running') {
        const recovered = await recoverOperationEffect(operation, sessionDir, projectRoot);
        if (recovered && !session.effects.some((effect) => effect.id === recovered.id)) {
          session.effects.push(recovered);
          const activity = session.timeline.find(
            (candidate) => candidate.kind === 'tool' && candidate.id === operation.toolActivityId,
          );
          if (activity?.kind === 'tool' && !activity.effectIds.includes(recovered.id)) {
            activity.effectIds.push(recovered.id);
          }
        }
        operation.state = 'failed';
        operation.error = 'Iris restarted before the tool operation settled.';
        operation.completedAt = now;
      }
    }
    for (const call of session.providerCalls) {
      if (call.turnId === turn.id && call.state === 'running') {
        call.state = 'failed';
        call.error = turn.error;
        call.completedAt = now;
      }
    }
    for (const attempt of session.providerAttempts) {
      if (attempt.turnId === turn.id && attempt.state === 'running') {
        attempt.state = 'failed';
        attempt.error = turn.error;
        attempt.completedAt = now;
      }
    }
  }
  session.state = 'paused';
  delete session.stopRequestedTurnId;
  return session;
}

async function recoverOperationEffect(
  operation: AgentSessionAggregate['toolOperations'][number],
  sessionDir: string,
  projectRoot: string,
): Promise<AgentSessionAggregate['effects'][number] | null> {
  const input = operation.input;
  if (input.tool !== 'edit' && input.tool !== 'write') return null;
  if (input.operation !== 'writeFile' && input.operation !== 'mkdir') return null;
  const effectId = `${input.operation === 'mkdir' ? 'directory' : 'file'}--${operation.id}`;
  const artifactRef = `effects/${effectId}.json`;
  let artifact: unknown;
  try {
    artifact = JSON.parse(await readFile(join(sessionDir, 'artifacts', ...artifactRef.split('/')), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(artifact) || typeof artifact.path !== 'string') return null;
  const target = resolve(projectRoot, input.absolutePath);
  assertInside(projectRoot, target);
  if (input.operation === 'mkdir') {
    const exists = await readdir(target).then(() => true, () => false);
    return exists ? {
      id: effectId,
      turnId: operation.turnId,
      toolActivityId: operation.toolActivityId,
      kind: 'directory-create',
      path: artifact.path,
      artifactRef,
      createdAt: operation.createdAt,
    } : null;
  }
  if (typeof artifact.afterSha256 !== 'string' || typeof artifact.operation !== 'string') return null;
  const content = await readFile(target, 'utf8').catch(() => null);
  if (content === null || sha256(content) !== artifact.afterSha256) return null;
  return {
    id: effectId,
    turnId: operation.turnId,
    toolActivityId: operation.toolActivityId,
    kind: 'file-write',
    path: artifact.path,
    operation: artifact.operation === 'edit' ? 'edit' : 'write',
    beforeSha256: typeof artifact.beforeSha256 === 'string' ? artifact.beforeSha256 : null,
    afterSha256: artifact.afterSha256,
    artifactRef,
    createdAt: operation.createdAt,
  };
}

function isInterrupted(session: AgentSessionAggregate): boolean {
  return session.state === 'starting' || session.state === 'running' || session.state === 'waiting-tool' ||
    session.state === 'retry-wait' || session.state === 'stopping';
}

async function readProjectIndex(path: string, projectRoot: string): Promise<ProjectIndex> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (isRecord(value) && value.version === IRIS_AGENT_SESSION_STORE_VERSION &&
      value.projectRoot === projectRoot && Array.isArray(value.sessionIds) &&
      value.sessionIds.every((id) => typeof id === 'string')) {
      return value as unknown as ProjectIndex;
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return { version: IRIS_AGENT_SESSION_STORE_VERSION, projectRoot, sessionIds: [] };
}

async function readSnapshot(path: string): Promise<SessionSnapshot | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isSessionSnapshot(value) ? value : null;
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function discoverSessionId(journalPath: string): Promise<string | null> {
  try {
    const firstLine = (await readFile(journalPath, 'utf8')).split(/\r?\n/u).find(Boolean);
    if (!firstLine) return null;
    const value: unknown = JSON.parse(firstLine);
    if (!isJournalRecord(value)) return null;
    const created = value.transaction.events[0];
    return created?.type === 'session.created' && isRecord(created.session) && typeof created.session.id === 'string'
      ? created.session.id
      : null;
  } catch {
    return null;
  }
}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  return isRecord(value) && value.version === IRIS_AGENT_SESSION_STORE_VERSION &&
    typeof value.revision === 'number' && typeof value.journalHash === 'string' &&
    isAgentSession(value.session);
}

function isJournalRecord(value: unknown): value is JournalRecord {
  return isRecord(value) && value.version === IRIS_AGENT_SESSION_STORE_VERSION &&
    typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0 &&
    typeof value.previousHash === 'string' && typeof value.journalHash === 'string' &&
    typeof value.committedAt === 'number' && isAgentDomainTransaction(value.transaction);
}

function isAgentSession(value: unknown): value is AgentSessionAggregate {
  return isRecord(value) && value.kind === 'iris-agent' && typeof value.id === 'string' &&
    typeof value.projectRoot === 'string' && typeof value.revision === 'number' &&
    Array.isArray(value.turns) && Array.isArray(value.timeline) &&
    Array.isArray(value.toolOperations) && Array.isArray(value.transcript) && Array.isArray(value.effects);
}

function isProviderContextBundle(value: unknown): value is IrisAgentProviderContextBundle {
  return isRecord(value) && value.schemaVersion === 2 && value.kind === 'provider-context-bundle' &&
    typeof value.sessionId === 'string' && typeof value.turnId === 'string' && Array.isArray(value.calls);
}

function isProviderContextCall(value: unknown): value is IrisAgentProviderContextCall {
  return isRecord(value) && typeof value.index === 'number' && typeof value.capturedAt === 'number' &&
    typeof value.provider === 'string' && typeof value.model === 'string' && typeof value.api === 'string' &&
    'payload' in value;
}

function journalHash(value: Omit<JournalRecord, 'journalHash'>): string {
  return sha256(JSON.stringify(value));
}

function projectKey(projectRoot: string): string {
  return sha256(resolve(projectRoot)).slice(0, 24);
}

function assertExactChild(parent: string, target: string, expectedName: string): void {
  if (dirname(target) !== parent || basename(target) !== expectedName) {
    throw new Error('Refusing to remove an unexpected Iris Agent legacy path.');
  }
}

function assertInside(parent: string, target: string): void {
  const rel = relative(resolve(parent), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep)) {
    throw new Error('Iris Agent storage path escaped its project store.');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
