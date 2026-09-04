import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  truncate,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from '../atomic-write';
import type { AgentHistorySnapshot } from '@shared/agent-protocol';
import type {
  IrisAgentProviderContextBundle,
  IrisAgentProviderContextCall,
  ProjectScope,
} from '@shared/types';
import type {
  AgentFileEffect,
  AgentIntent,
  AgentInvoke,
  AgentInvokeAttempt,
  AgentSessionAggregate,
  AgentTimelineActivity,
  AgentTurn,
} from './session-model';
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
import { buildAgentContextFromSession } from './trace-context';

export const IRIS_AGENT_SESSION_STORE_VERSION = 3 as const;
const LEGACY_AGENT_SESSION_STORE_VERSION = 2 as const;
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

interface LegacyJournalRecord {
  version: typeof LEGACY_AGENT_SESSION_STORE_VERSION;
  revision: number;
  previousHash: string;
  journalHash: string;
  committedAt: number;
  transaction: LegacyDomainTransaction;
}

type StoredJournalRecord = JournalRecord | LegacyJournalRecord;

interface LegacyDomainTransaction {
  events: Array<Record<string, unknown>>;
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
      for (const intent of loaded.session.intents) {
        await store.migrateLegacyIntentArtifactDirectory(id, intent.id);
      }
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

  async commitBranch(
    sourceSessionId: string,
    branch: AgentSessionAggregate,
  ): Promise<AgentSessionAggregate> {
    const source = this.sessions.get(sourceSessionId);
    if (!source) throw new Error('[IrisAgentSessionStore] unknown source session ' + sourceSessionId);
    if (branch.id === source.id || branch.parentSessionId !== source.id) {
      throw new Error('Iris Agent branch does not identify its source session.');
    }
    if (this.sessions.has(branch.id)) {
      throw new Error('Iris Agent branch session already exists.');
    }
    const directory = this.sessionDir(branch.id);
    const exists = await lstat(directory).then(() => true, (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    });
    if (exists) throw new Error('Iris Agent branch storage already exists.');

    try {
      await this.copyBranchArtifacts(source, branch);
      return await this.commit(branch);
    } catch (error) {
      if (!this.sessions.has(branch.id)) {
        assertInside(join(this.projectDir, 'sessions'), directory);
        await rm(directory, { recursive: true, force: true });
      }
      throw error;
    }
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

  async rewindIntentEffects(
    sessionId: string,
    intentId: string,
  ): Promise<{ revertedEffectIds: string[]; retainedEffectIds: string[] }> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('[IrisAgentSessionStore] unknown session ' + sessionId);
    const effects = session.effects.filter((effect) => effect.intentId === intentId).reverse();
    const virtualContents = new Map<string, string | null>();
    const files: Array<{ effect: AgentFileEffect; target: string; beforeContent: string | null }> = [];
    const directories: Array<{ id: string; target: string }> = [];
    const retainedEffectIds: string[] = [];

    for (const effect of effects) {
      if (effect.kind === 'terminal-output') {
        retainedEffectIds.push(effect.id);
        continue;
      }
      const target = resolve(this.projectRoot, effect.path);
      assertProjectTarget(this.projectRoot, target);
      const parent = await realpath(dirname(target));
      assertProjectLocation(this.projectRoot, parent);
      const metadata = await lstat(target).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (metadata?.isSymbolicLink()) {
        throw new Error(`Cannot rewind ${effect.path}: the target is now a symbolic link.`);
      }
      if (effect.kind === 'directory-create') {
        if (!metadata?.isDirectory()) {
          throw new Error(`Cannot rewind ${effect.path}: the created directory no longer exists.`);
        }
        directories.push({ id: effect.id, target });
        continue;
      }

      const artifactPath = resolve(this.artifactRoot(sessionId), ...effect.artifactRef.split('/'));
      assertProjectTarget(this.artifactRoot(sessionId), artifactPath);
      const artifact: unknown = JSON.parse(await readFile(artifactPath, 'utf8'));
      if (!isFileEffectArtifact(artifact) || artifact.path !== effect.path ||
        artifact.afterSha256 !== effect.afterSha256 || artifact.beforeSha256 !== effect.beforeSha256 ||
        sha256(artifact.afterContent) !== effect.afterSha256 ||
        (artifact.beforeContent !== null && sha256(artifact.beforeContent) !== effect.beforeSha256)) {
        throw new Error(`Cannot rewind ${effect.path}: its effect artifact is invalid.`);
      }
      const current = virtualContents.has(target)
        ? virtualContents.get(target)!
        : await readFile(target, 'utf8').catch((error: unknown) => {
            if (isMissing(error)) return null;
            throw error;
          });
      if (current === null || sha256(current) !== effect.afterSha256) {
        throw new Error(`Cannot rewind ${effect.path}: the file changed after this Intent wrote it.`);
      }
      virtualContents.set(target, artifact.beforeContent);
      files.push({ effect, target, beforeContent: artifact.beforeContent });
    }

    const revertedEffectIds: string[] = [];
    for (const file of files) {
      if (file.beforeContent === null) await unlink(file.target);
      else await writeFileAtomic(file.target, file.beforeContent);
      revertedEffectIds.push(file.effect.id);
    }
    for (const directory of directories) {
      try {
        await rmdir(directory.target);
        revertedEffectIds.push(directory.id);
      } catch (error) {
        if (isMissing(error)) {
          revertedEffectIds.push(directory.id);
        } else if (isRecord(error) && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST')) {
          retainedEffectIds.push(directory.id);
        } else {
          throw error;
        }
      }
    }
    return { revertedEffectIds, retainedEffectIds };
  }

  async savePromptSnapshot(sessionId: string, intentId: string, prompt: string): Promise<void> {
    await writeFileAtomic(this.promptSnapshotPath(sessionId, intentId), prompt);
  }

  promptSnapshotPath(sessionId: string, intentId: string): string {
    return join(this.intentArtifactDir(sessionId, intentId), 'assembled-input.txt');
  }

  artifactRoot(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'artifacts');
  }

  async appendProviderContext(
    sessionId: string,
    intentId: string,
    call: IrisAgentProviderContextCall,
    assembledInputAvailable = true,
    runtimeIdentity?: NonNullable<IrisAgentProviderContextBundle['runtimeIdentity']>,
  ): Promise<IrisAgentProviderContextBundle> {
    const existing = await this.readProviderContextBundle(sessionId, intentId);
    const sanitized = sanitizeProviderContextCall(call);
    const calls = existing?.calls ?? [];
    const duplicate = calls.find((candidate) => candidate.index === sanitized.index);
    if (duplicate) return existing!;
    const callBase = `call-${String(calls.length).padStart(3, '0')}`;
    const jsonFile = callBase + '.json';
    const textFile = callBase + '.txt';
    const callJson = JSON.stringify(sanitized, null, 2) + '\n';
    const bundle: IrisAgentProviderContextBundle = {
      schemaVersion: 3,
      kind: 'provider-context-bundle',
      sessionId,
      intentId,
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
    const contextDir = this.providerContextDir(sessionId, intentId);
    await writeFileAtomic(join(contextDir, jsonFile), callJson);
    await writeFileAtomic(join(contextDir, textFile), renderProviderContextCall(sanitized));
    await writeFileAtomic(this.providerContextJsonPath(sessionId, intentId), JSON.stringify(bundle, null, 2) + '\n');
    await this.refreshProviderContextText(sessionId, intentId).catch(() => undefined);
    return bundle;
  }

  providerContextTextPath(sessionId: string, intentId: string): string {
    return join(this.providerContextDir(sessionId, intentId), 'index.txt');
  }

  async refreshProviderContextText(sessionId: string, intentId: string): Promise<void> {
    const bundle = await this.readProviderContextBundle(sessionId, intentId);
    if (!bundle) throw new Error('Provider context bundle is unavailable.');
    const calls = await this.loadIndexedInvokes(sessionId, intentId, bundle.calls);
    const attempts = this.sessions.get(sessionId)?.invokeAttempts.filter(
      (attempt) => attempt.intentId === intentId,
    ) ?? [];
    await writeFileAtomic(
      this.providerContextTextPath(sessionId, intentId),
      renderProviderContextIndex(bundle, calls, attempts),
    );
  }

  history(sessionId: string): AgentHistorySnapshot {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('[IrisAgentSessionStore] unknown session ' + sessionId);
    return buildAgentContextFromSession(session);
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
      const records: StoredJournalRecord[] = [];
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
        let legacySession: Record<string, unknown> | null = null;
        let migratedLegacy = false;
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
          if (record.version === IRIS_AGENT_SESSION_STORE_VERSION) {
            if (!session && legacySession) {
              session = migrateLegacyAgentSession(legacySession);
              migratedLegacy = true;
            }
            session = applyAgentDomainTransaction(session, record.transaction);
          } else {
            if (session) throw new Error('Legacy Iris Agent events appeared after the architecture migration.');
            legacySession = applyLegacyDomainTransaction(legacySession, record.transaction);
          }
          const replayedRevision = session?.revision ??
            (typeof legacySession?.revision === 'number' ? legacySession.revision : null);
          if (replayedRevision !== record.revision) {
            throw new Error('Iris Agent journal transaction produced the wrong revision.');
          }
        }
        if (!session && legacySession) {
          session = migrateLegacyAgentSession(legacySession);
          migratedLegacy = true;
        }
        const latest = records[records.length - 1]!;
        if (session?.id !== sessionId || session.projectRoot !== this.projectRoot) return null;
        const loaded = {
          version: IRIS_AGENT_SESSION_STORE_VERSION,
          revision: latest.revision,
          journalHash: latest.journalHash,
          session: cloneAgentSession(session),
        } satisfies SessionSnapshot;
        if (migratedLegacy && isAgentSessionQuiescent(session)) {
          await writeFileAtomic(
            join(directory, 'snapshot.json'),
            JSON.stringify(loaded, null, 2) + '\n',
          );
        }
        return loaded;
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

  private intentArtifactDir(sessionId: string, intentId: string): string {
    return join(this.sessionDir(sessionId), 'artifacts', 'intents', sha256(intentId).slice(0, 32));
  }

  private providerContextDir(sessionId: string, intentId: string): string {
    return join(this.intentArtifactDir(sessionId, intentId), 'provider-context');
  }

  private async copyBranchArtifacts(
    source: AgentSessionAggregate,
    branch: AgentSessionAggregate,
  ): Promise<void> {
    const sourceIntentIds = new Set(source.intents.map((intent) => intent.id));
    for (const intent of branch.intents) {
      if (!sourceIntentIds.has(intent.id)) {
        throw new Error('Iris Agent branch contains an Intent outside its source session.');
      }
      if (!intent.assembledInputAvailable) continue;
      await assertImmutableArtifactPath(
        this.artifactRoot(source.id),
        this.intentArtifactDir(source.id, intent.id),
      );
      await copyImmutableArtifactTree(
        this.intentArtifactDir(source.id, intent.id),
        this.intentArtifactDir(branch.id, intent.id),
      );
      await this.rewriteBranchedProviderContext(source.id, branch, intent.id);
    }

    const artifactRefs = new Set(branch.effects.map((effect) => effect.artifactRef));
    for (const activity of branch.timeline) {
      if (activity.kind === 'tool' && activity.terminalArtifactRef) {
        artifactRefs.add(activity.terminalArtifactRef);
      }
    }
    const sourceRoot = this.artifactRoot(source.id);
    const branchRoot = this.artifactRoot(branch.id);
    const copiedTargets = new Set<string>();
    for (const artifactRef of artifactRefs) {
      const sourcePath = resolve(sourceRoot, ...artifactRef.split('/'));
      const branchPath = resolve(branchRoot, ...artifactRef.split('/'));
      assertInside(sourceRoot, sourcePath);
      assertInside(branchRoot, branchPath);
      if (copiedTargets.has(branchPath)) continue;
      copiedTargets.add(branchPath);
      await assertImmutableArtifactPath(sourceRoot, sourcePath);
      await copyImmutableArtifactFile(sourcePath, branchPath);
    }
  }

  private async rewriteBranchedProviderContext(
    sourceSessionId: string,
    branch: AgentSessionAggregate,
    intentId: string,
  ): Promise<void> {
    const path = this.providerContextJsonPath(branch.id, intentId);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const sourceBundle = isProviderContextBundle(value)
      ? value
      : migrateLegacyProviderContextBundle(value);
    if (!sourceBundle || sourceBundle.sessionId !== sourceSessionId || sourceBundle.intentId !== intentId) {
      throw new Error('Iris Agent branch provider context has invalid ownership.');
    }
    const bundle: IrisAgentProviderContextBundle = {
      ...structuredClone(sourceBundle),
      schemaVersion: 3,
      sessionId: branch.id,
      intentId,
    };
    await writeFileAtomic(path, JSON.stringify(bundle, null, 2) + '\n');
    const calls = await this.loadIndexedInvokes(branch.id, intentId, bundle.calls);
    const attempts = branch.invokeAttempts.filter((attempt) => attempt.intentId === intentId);
    await writeFileAtomic(
      this.providerContextTextPath(branch.id, intentId),
      renderProviderContextIndex(bundle, calls, attempts),
    );
  }

  private async migrateLegacyIntentArtifactDirectory(sessionId: string, intentId: string): Promise<void> {
    const legacy = join(this.sessionDir(sessionId), 'artifacts', 'turns', sha256(intentId).slice(0, 32));
    const current = this.intentArtifactDir(sessionId, intentId);
    const currentExists = await lstat(current).then(() => true, (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    });
    if (currentExists) return;
    const legacyExists = await lstat(legacy).then(() => true, (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    });
    if (!legacyExists) return;
    await mkdir(dirname(current), { recursive: true });
    await rename(legacy, current);
    await rmdir(dirname(legacy)).catch((error: unknown) => {
      if (!isMissing(error) && (!isRecord(error) || (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST'))) {
        throw error;
      }
    });
  }

  private providerContextJsonPath(sessionId: string, intentId: string): string {
    return join(this.providerContextDir(sessionId, intentId), 'index.json');
  }

  private async readProviderContextBundle(
    sessionId: string,
    intentId: string,
  ): Promise<IrisAgentProviderContextBundle | null> {
    try {
      const path = this.providerContextJsonPath(sessionId, intentId);
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (isProviderContextBundle(value)) return value;
      const migrated = migrateLegacyProviderContextBundle(value);
      if (!migrated) return null;
      await writeFileAtomic(path, JSON.stringify(migrated, null, 2) + '\n');
      return migrated;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async loadIndexedInvokes(
    sessionId: string,
    intentId: string,
    calls: IrisAgentProviderContextBundle['calls'],
  ): Promise<IrisAgentProviderContextCall[]> {
    return Promise.all(calls.map(async (indexed) => {
      const raw = await readFile(join(this.providerContextDir(sessionId, intentId), indexed.jsonFile), 'utf8');
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
  const intent = session.intents.find((candidate) => candidate.id === session.currentIntentId);
  const now = Date.now();
  if (intent) {
    const message = 'Iris restarted before the Agent intent settled.';
    intent.state = 'paused';
    intent.pauseReason = 'restart';
    intent.pauseMessage = message;
    for (const activity of session.timeline) {
      if (activity.kind === 'reply' && activity.intentId === intent.id && activity.state === 'streaming') {
        activity.state = 'stopped';
        activity.contextDisposition = 'excluded';
        activity.completedAt = now;
      }
      if (activity.kind === 'tool' && activity.intentId === intent.id && activity.state === 'running') {
        activity.state = 'canceled';
        activity.completedAt = now;
        if (activity.tool === 'terminal') {
          activity.terminalState = 'exited';
          activity.terminalOutcome = 'canceled';
          activity.terminalCompletedAt = now;
        }
      }
    }
    for (const operation of session.toolOperations) {
      if (operation.intentId === intent.id && operation.state === 'running') {
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
    for (const call of session.invokes) {
      if (call.intentId === intent.id && call.state === 'running') {
        call.state = 'failed';
        call.error = message;
        call.completedAt = now;
      }
    }
    for (const attempt of session.invokeAttempts) {
      if (attempt.intentId === intent.id && attempt.state === 'running') {
        attempt.state = 'failed';
        attempt.error = message;
        attempt.completedAt = now;
      }
    }
    for (const turn of session.turns) {
      if (turn.intentId === intent.id && turn.state === 'running') {
        turn.state = 'settled';
        turn.settledAt = now;
      }
    }
  }
  session.state = 'paused';
  delete session.stopRequestedIntentId;
  delete session.terminalSupervisionAlert;
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
      intentId: operation.intentId,
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
    intentId: operation.intentId,
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

function isJournalRecord(value: unknown): value is StoredJournalRecord {
  return isRecord(value) &&
    (value.version === IRIS_AGENT_SESSION_STORE_VERSION ||
      value.version === LEGACY_AGENT_SESSION_STORE_VERSION) &&
    typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0 &&
    typeof value.previousHash === 'string' && typeof value.journalHash === 'string' &&
    typeof value.committedAt === 'number' &&
    (value.version === IRIS_AGENT_SESSION_STORE_VERSION
      ? isAgentDomainTransaction(value.transaction)
      : isLegacyDomainTransaction(value.transaction));
}

function isLegacyDomainTransaction(value: unknown): value is LegacyDomainTransaction {
  if (!isRecord(value) || !Array.isArray(value.events) || value.events.length === 0) return false;
  const collections = new Set([
    'turns', 'intents', 'providerCalls', 'providerAttempts', 'timeline',
    'toolOperations', 'transcript', 'effects', 'requestFacts', 'undoReceipts',
  ]);
  return value.events.every((event) => {
    if (!isRecord(event) || typeof event.type !== 'string') return false;
    if (event.type === 'session.created') return isRecord(event.session);
    if (event.type === 'session.updated') {
      return isRecord(event.patch) && Array.isArray(event.removedKeys) &&
        event.removedKeys.every((key) => typeof key === 'string');
    }
    if (event.type === 'entity.removed') {
      return typeof event.collection === 'string' && collections.has(event.collection) &&
        typeof event.entityId === 'string';
    }
    return event.type === 'entity.upserted' && typeof event.collection === 'string' &&
      collections.has(event.collection) && isRecord(event.entity);
  });
}

function applyLegacyDomainTransaction(
  previous: Record<string, unknown> | null,
  transaction: LegacyDomainTransaction,
): Record<string, unknown> {
  let session = previous ? structuredClone(previous) : null;
  for (const event of transaction.events) {
    if (event.type === 'session.created') {
      if (session || !isRecord(event.session)) throw new Error('Invalid legacy Iris Agent creation event.');
      session = structuredClone(event.session);
      continue;
    }
    if (!session) throw new Error('Legacy Iris Agent event preceded Session creation.');
    if (event.type === 'session.updated') {
      if (!isRecord(event.patch) || !Array.isArray(event.removedKeys)) {
        throw new Error('Invalid legacy Iris Agent update event.');
      }
      Object.assign(session, structuredClone(event.patch));
      for (const key of event.removedKeys) if (typeof key === 'string') delete session[key];
      continue;
    }
    if (typeof event.collection !== 'string') throw new Error('Invalid legacy Iris Agent entity event.');
    const target = session[event.collection];
    if (!Array.isArray(target)) throw new Error('Legacy Iris Agent entity collection is missing.');
    if (event.type === 'entity.removed') {
      const index = target.findIndex((entity) => legacyEntityId(event.collection as string, entity) === event.entityId);
      if (index >= 0) target.splice(index, 1);
      continue;
    }
    if (event.type !== 'entity.upserted' || !isRecord(event.entity)) {
      throw new Error('Invalid legacy Iris Agent entity event.');
    }
    const id = legacyEntityId(event.collection, event.entity);
    const index = target.findIndex((entity) => legacyEntityId(event.collection as string, entity) === id);
    if (index < 0) target.push(structuredClone(event.entity));
    else target[index] = structuredClone(event.entity);
  }
  if (!session) throw new Error('Legacy Iris Agent transaction did not create a Session.');
  return session;
}

function legacyEntityId(collection: string, entity: unknown): unknown {
  if (!isRecord(entity)) return undefined;
  return collection === 'undoReceipts' ? entity.commandId : entity.id;
}

export function migrateLegacyAgentSession(legacy: Record<string, unknown>): AgentSessionAggregate {
  if (isAgentSession(legacy)) return cloneAgentSession(legacy);
  const oldTurns = records(legacy.turns);
  const oldCalls = records(legacy.providerCalls);
  const oldAttempts = records(legacy.providerAttempts);
  const oldTimeline = records(legacy.timeline);
  const oldTranscript = records(legacy.transcript);
  const oldEffects = records(legacy.effects);
  const oldOperations = records(legacy.toolOperations);
  const oldRequestFacts = records(legacy.requestFacts);
  const oldReceipts = records(legacy.undoReceipts);
  const removedIntentIds = new Set(oldReceipts.flatMap((receipt) =>
    typeof receipt.removedTurnId === 'string' ? [receipt.removedTurnId] : []));
  const userByTurn = new Map(oldTimeline.flatMap((activity) =>
    activity.kind === 'user' && typeof activity.turnId === 'string'
      ? [[activity.turnId, activity] as const]
      : []));
  const invokeTurnId = (invokeId: string) => `turn:${invokeId}`;

  const intents: AgentIntent[] = oldTurns.flatMap((oldTurn) => {
    if (typeof oldTurn.id !== 'string') return [];
    const user = userByTurn.get(oldTurn.id);
    const oldState = typeof oldTurn.state === 'string' ? oldTurn.state : 'paused';
    const state: AgentIntent['state'] = removedIntentIds.has(oldTurn.id) ||
      oldState === 'removed' || oldState === 'abandoned'
      ? 'superseded'
      : oldState === 'fulfilled'
        ? 'completed'
        : oldState === 'running'
          ? 'running'
          : 'paused';
    return [{
      id: oldTurn.id,
      content: typeof user?.content === 'string' ? user.content : '',
      turnIds: oldCalls.flatMap((call) =>
        call.turnId === oldTurn.id && typeof call.id === 'string' ? [invokeTurnId(call.id)] : []),
      state,
      ...(state === 'paused'
        ? {
            pauseReason: legacyPauseReason(oldTurn.pauseReason),
            pauseMessage: typeof oldTurn.error === 'string' ? oldTurn.error : 'Paused during architecture migration.',
          }
        : {}),
      assembledInputAvailable: oldTurn.assembledInputAvailable === true,
      createdAt: numberValue(oldTurn.createdAt),
      ...(typeof oldTurn.closedAt === 'number' ? { closedAt: oldTurn.closedAt } : {}),
    }];
  });
  const intentById = new Map(intents.map((intent) => [intent.id, intent]));

  const invokes: AgentInvoke[] = oldCalls.flatMap((call) => {
    if (typeof call.id !== 'string' || typeof call.turnId !== 'string' || !intentById.has(call.turnId)) return [];
    return [{
      id: call.id,
      intentId: call.turnId,
      turnId: invokeTurnId(call.id),
      index: numberValue(call.index, 1),
      state: legacyInvokeState(call.state),
      attemptIds: Array.isArray(call.attemptIds)
        ? call.attemptIds.filter((id): id is string => typeof id === 'string')
        : [],
      createdAt: numberValue(call.createdAt),
      ...(typeof call.completedAt === 'number' ? { completedAt: call.completedAt } : {}),
      ...(typeof call.error === 'string' ? { error: call.error } : {}),
    }];
  });
  const invokeById = new Map(invokes.map((invoke) => [invoke.id, invoke]));

  const invokeAttempts: AgentInvokeAttempt[] = oldAttempts.flatMap((attempt) => {
    const invokeId = typeof attempt.providerCallId === 'string' ? attempt.providerCallId : null;
    const invoke = invokeId ? invokeById.get(invokeId) : undefined;
    if (!invoke || typeof attempt.id !== 'string') return [];
    return [{
      id: attempt.id,
      invokeId: invoke.id,
      intentId: invoke.intentId,
      turnId: invoke.turnId,
      index: numberValue(attempt.index, 1),
      state: legacyInvokeState(attempt.state),
      createdAt: numberValue(attempt.createdAt),
      ...(typeof attempt.completedAt === 'number' ? { completedAt: attempt.completedAt } : {}),
      ...(typeof attempt.error === 'string' ? { error: attempt.error } : {}),
    }];
  });

  const turns: AgentTurn[] = invokes.map((invoke) => {
    const assistantFrames = oldTranscript.filter((frame) =>
      frame.role === 'assistant' && frame.providerCallId === invoke.id);
    const assistantFrame = assistantFrames.at(-1);
    const providerMessage = isRecord(assistantFrame?.providerMessage)
      ? assistantFrame.providerMessage
      : null;
    const stopReason = providerMessage && typeof providerMessage.stopReason === 'string'
      ? providerMessage.stopReason
      : '';
    const assistant = assistantFrame && stopReason !== 'error' && stopReason !== 'aborted'
      ? {
          content: providerMessageText(providerMessage) ??
            (typeof assistantFrame.content === 'string' ? assistantFrame.content : ''),
          toolCalls: legacyProviderToolCalls(providerMessage),
          createdAt: numberValue(assistantFrame.createdAt, invoke.createdAt),
        }
      : null;
    const toolResults = assistant?.toolCalls.flatMap((call) => {
      const frame = oldTranscript.find((candidate) =>
        candidate.role === 'tool' && candidate.toolCallId === call.id &&
        !(typeof candidate.id === 'string' && candidate.id.startsWith('interrupted-tool-result:')));
      if (!frame) return [];
      const raw = isRecord(frame.providerMessage) ? frame.providerMessage : null;
      return [{
        toolCallId: call.id,
        tool: call.tool,
        content: providerMessageText(raw) ?? (typeof frame.content === 'string' ? frame.content : ''),
        isError: raw?.isError === true,
        createdAt: numberValue(frame.createdAt, invoke.createdAt),
      }];
    }) ?? [];
    const intent = intentById.get(invoke.intentId)!;
    const settled = intent.state !== 'running' || invoke.state !== 'running' ||
      (!!assistant && assistant.toolCalls.length === toolResults.length);
    return {
      id: invoke.turnId,
      intentId: invoke.intentId,
      invokeId: invoke.id,
      state: settled ? 'settled' : 'running',
      assistant,
      toolResults,
      createdAt: invoke.createdAt,
      ...(settled ? { settledAt: invoke.completedAt ?? invoke.createdAt } : {}),
    };
  });

  const timeline: AgentTimelineActivity[] = oldTimeline.flatMap((activity) => {
    if ((activity.kind !== 'reply' && activity.kind !== 'tool') ||
      typeof activity.id !== 'string' || typeof activity.turnId !== 'string' ||
      typeof activity.providerCallId !== 'string') return [];
    const invoke = invokeById.get(activity.providerCallId);
    if (!invoke || invoke.intentId !== activity.turnId) return [];
    const common = {
      ...structuredClone(activity),
      intentId: activity.turnId,
      turnId: invoke.turnId,
      invokeId: invoke.id,
      ...(activity.kind === 'reply' && typeof activity.providerAttemptId === 'string'
        ? { invokeAttemptId: activity.providerAttemptId }
        : {}),
    };
    delete (common as Record<string, unknown>).providerCallId;
    delete (common as Record<string, unknown>).providerAttemptId;
    return [common as unknown as AgentTimelineActivity];
  });
  const activityById = new Map(timeline.map((activity) => [activity.id, activity]));

  const toolOperations = oldOperations.flatMap((operation) => {
    if (typeof operation.id !== 'string' || typeof operation.toolActivityId !== 'string') return [];
    const activity = activityById.get(operation.toolActivityId);
    if (activity?.kind !== 'tool') return [];
    const migrated = {
      ...structuredClone(operation),
      intentId: activity.intentId,
      turnId: activity.turnId,
    };
    return [migrated as AgentSessionAggregate['toolOperations'][number]];
  });
  const effects = oldEffects.flatMap((effect) => {
    if (typeof effect.id !== 'string' || typeof effect.toolActivityId !== 'string') return [];
    const activity = activityById.get(effect.toolActivityId);
    if (activity?.kind !== 'tool') return [];
    const migrated = {
      ...structuredClone(effect),
      intentId: activity.intentId,
      turnId: activity.turnId,
    };
    return [migrated as AgentSessionAggregate['effects'][number]];
  });
  const requestFacts = oldRequestFacts.flatMap((facts) => {
    if (typeof facts.id !== 'string' || typeof facts.turnId !== 'string' || !intentById.has(facts.turnId)) return [];
    return [{
      id: facts.id,
      intentId: facts.turnId,
      createdAt: numberValue(facts.createdAt),
      promptFingerprint: stringValue(facts.promptFingerprint),
      layerFingerprints: isLayerFingerprints(facts.layerFingerprints)
        ? structuredClone(facts.layerFingerprints)
        : { agent: '', software: '', project: '', anchor: '' },
      anchor: isLegacyAnchor(facts.anchor)
        ? structuredClone(facts.anchor)
        : structuredClone(legacy.anchor) as AgentSessionAggregate['anchor'],
      anchorPatch: [],
      promptChars: numberValue(facts.promptChars),
      redacted: true as const,
    }];
  });
  const rewindReceipts = oldReceipts.flatMap((receipt) => {
    if (typeof receipt.commandId !== 'string' || typeof receipt.removedTurnId !== 'string' ||
      !intentById.has(receipt.removedTurnId)) return [];
    return [{
      commandId: receipt.commandId,
      truncatedIntentId: receipt.removedTurnId,
      revertedEffectIds: [],
      retainedEffectIds: effects.filter((effect) => effect.intentId === receipt.removedTurnId)
        .map((effect) => effect.id),
      createdAt: numberValue(receipt.removedAt),
    }];
  });
  const activeIntentIds = intents.filter((intent) => intent.state !== 'superseded').map((intent) => intent.id);
  const oldCurrentId = typeof legacy.currentTurnId === 'string' ? legacy.currentTurnId : null;
  const currentIntentId = oldCurrentId && activeIntentIds.includes(oldCurrentId) ? oldCurrentId : null;
  const baselineText = oldRequestFacts.find((facts) => typeof facts.anchorSnapshot === 'string')?.anchorSnapshot;
  const anchor = structuredClone(legacy.anchor) as AgentSessionAggregate['anchor'];
  if (!isLegacyAnchor(anchor)) throw new Error('Legacy Iris Agent Session anchor is invalid.');

  return {
    id: stringValue(legacy.id),
    kind: 'iris-agent',
    anchor,
    model: isLegacyModel(legacy.model) ? structuredClone(legacy.model) : null,
    ...(typeof legacy.parentSessionId === 'string' ? { parentSessionId: legacy.parentSessionId } : {}),
    ...(typeof legacy.forkedFromTurnId === 'string'
      ? { forkedFromIntentId: legacy.forkedFromTurnId }
      : {}),
    projectRoot: stringValue(legacy.projectRoot),
    displayName: stringValue(legacy.displayName),
    state: stringValue(legacy.state) as AgentSessionAggregate['state'],
    revision: numberValue(legacy.revision),
    workerEpoch: numberValue(legacy.workerEpoch),
    nextOrdinal: Math.max(0, ...timeline.map((activity) => activity.ordinal)) + 1,
    currentIntentId,
    ...(typeof legacy.stopRequestedTurnId === 'string'
      ? { stopRequestedIntentId: legacy.stopRequestedTurnId }
      : {}),
    ...(isRecord(legacy.terminalSupervisionAlert)
      ? { terminalSupervisionAlert: structuredClone(legacy.terminalSupervisionAlert) as NonNullable<AgentSessionAggregate['terminalSupervisionAlert']> }
      : {}),
    activeIntentIds,
    intents,
    turns,
    invokes,
    invokeAttempts,
    timeline,
    toolOperations,
    effects,
    requestFacts,
    rewindReceipts,
    injection: {
      methods: { agent: 'current', software: 'current', project: 'current' },
      anchor: {
        path: anchor.path,
        baselineText: typeof baselineText === 'string' ? baselineText : '',
        baselineSha256: sha256(typeof baselineText === 'string' ? baselineText : ''),
        capturedAt: numberValue(legacy.createdAt),
      },
    },
    createdAt: numberValue(legacy.createdAt),
    updatedAt: numberValue(legacy.updatedAt),
    selfHostingEligible: false,
  };
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function legacyInvokeState(value: unknown): AgentInvoke['state'] {
  return value === 'completed' || value === 'failed' || value === 'aborted' ? value : 'running';
}

function legacyPauseReason(value: unknown): NonNullable<AgentIntent['pauseReason']> {
  return value === 'user' || value === 'provider' || value === 'worker' || value === 'restart'
    ? value
    : 'runtime';
}

function legacyProviderToolCalls(message: Record<string, unknown> | null): NonNullable<AgentTurn['assistant']>['toolCalls'] {
  if (!Array.isArray(message?.content)) return [];
  return message.content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'toolCall' || typeof block.id !== 'string' ||
      !isLegacyToolName(block.name)) return [];
    return [{ id: block.id, tool: block.name, input: structuredClone(block.arguments ?? {}) }];
  });
}

function providerMessageText(message: Record<string, unknown> | null): string | null {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return null;
  return message.content.flatMap((part) =>
    isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
}

function isLegacyToolName(value: unknown): value is NonNullable<AgentTurn['assistant']>['toolCalls'][number]['tool'] {
  return value === 'read' || value === 'edit' || value === 'write' || value === 'terminal';
}

function isLayerFingerprints(value: unknown): value is AgentSessionAggregate['requestFacts'][number]['layerFingerprints'] {
  return isRecord(value) && typeof value.agent === 'string' && typeof value.software === 'string' &&
    typeof value.project === 'string' && typeof value.anchor === 'string';
}

function isLegacyAnchor(value: unknown): value is AgentSessionAggregate['anchor'] {
  return isRecord(value) && (value.kind === 'document' || value.kind === 'workspace') &&
    typeof value.path === 'string';
}

function isLegacyModel(value: unknown): value is NonNullable<AgentSessionAggregate['model']> {
  return isRecord(value) && typeof value.provider === 'string' && typeof value.modelId === 'string';
}

function isAgentSession(value: unknown): value is AgentSessionAggregate {
  return isRecord(value) && value.kind === 'iris-agent' && typeof value.id === 'string' &&
    typeof value.projectRoot === 'string' && typeof value.revision === 'number' &&
    Array.isArray(value.activeIntentIds) && Array.isArray(value.intents) && Array.isArray(value.turns) &&
    Array.isArray(value.invokes) && Array.isArray(value.invokeAttempts) && Array.isArray(value.timeline) &&
    Array.isArray(value.toolOperations) && Array.isArray(value.effects) &&
    Array.isArray(value.requestFacts) && Array.isArray(value.rewindReceipts) && isRecord(value.injection);
}

function isProviderContextBundle(value: unknown): value is IrisAgentProviderContextBundle {
  return isRecord(value) && value.schemaVersion === 3 && value.kind === 'provider-context-bundle' &&
    typeof value.sessionId === 'string' && typeof value.intentId === 'string' &&
    isProviderContextBundleBody(value);
}

function migrateLegacyProviderContextBundle(value: unknown): IrisAgentProviderContextBundle | null {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.kind !== 'provider-context-bundle' ||
    typeof value.sessionId !== 'string' || typeof value.turnId !== 'string' ||
    !isProviderContextBundleBody(value)) return null;
  return {
    schemaVersion: 3,
    kind: 'provider-context-bundle',
    sessionId: value.sessionId,
    intentId: value.turnId,
    createdAt: value.createdAt,
    assembledInput: { available: value.assembledInput.available },
    contextStage: 'provider-payload',
    compaction: 'disabled',
    ...(isProviderRuntimeIdentity(value.runtimeIdentity)
      ? {
          runtimeIdentity: structuredClone(value.runtimeIdentity),
        }
      : {}),
    calls: structuredClone(value.calls),
  };
}

function isProviderContextBundleBody(value: Record<string, unknown>): value is Record<string, unknown> & {
  createdAt: number;
  assembledInput: { available: boolean };
  contextStage: 'provider-payload';
  compaction: 'disabled';
  runtimeIdentity?: NonNullable<IrisAgentProviderContextBundle['runtimeIdentity']>;
  calls: IrisAgentProviderContextBundle['calls'];
} {
  return typeof value.createdAt === 'number' && isRecord(value.assembledInput) &&
    typeof value.assembledInput.available === 'boolean' && value.contextStage === 'provider-payload' &&
    value.compaction === 'disabled' &&
    (value.runtimeIdentity === undefined || isProviderRuntimeIdentity(value.runtimeIdentity)) &&
    Array.isArray(value.calls) && value.calls.every(isProviderContextIndexCall);
}

function isProviderRuntimeIdentity(
  value: unknown,
): value is NonNullable<IrisAgentProviderContextBundle['runtimeIdentity']> {
  return isRecord(value) && typeof value.appVersion === 'string' &&
    typeof value.protocolVersion === 'number' && typeof value.sessionRevision === 'number' &&
    typeof value.workerEpoch === 'number';
}

function isProviderContextIndexCall(
  value: unknown,
): value is IrisAgentProviderContextBundle['calls'][number] {
  return isRecord(value) && typeof value.index === 'number' && typeof value.capturedAt === 'number' &&
    typeof value.provider === 'string' && typeof value.model === 'string' &&
    typeof value.api === 'string' && typeof value.jsonFile === 'string' &&
    typeof value.textFile === 'string' && typeof value.sha256 === 'string';
}

function isProviderContextCall(value: unknown): value is IrisAgentProviderContextCall {
  return isRecord(value) && typeof value.index === 'number' && typeof value.capturedAt === 'number' &&
    typeof value.provider === 'string' && typeof value.model === 'string' && typeof value.api === 'string' &&
    'payload' in value;
}

function journalHash(value: {
  version: number;
  revision: number;
  previousHash: string;
  committedAt: number;
  transaction: AgentDomainTransaction | LegacyDomainTransaction;
}): string {
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

async function copyImmutableArtifactTree(source: string, target: string): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) {
    throw new Error('Iris Agent cannot branch a symbolic-link artifact.');
  }
  if (metadata.isFile()) {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target, fsConstants.COPYFILE_EXCL);
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error('Iris Agent cannot branch a special-file artifact.');
  }
  const targetExists = await lstat(target).then(() => true, (error: unknown) => {
    if (isMissing(error)) return false;
    throw error;
  });
  if (targetExists) throw new Error('Iris Agent branch artifact target already exists.');
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source)) {
    await copyImmutableArtifactTree(join(source, entry), join(target, entry));
  }
}

async function assertImmutableArtifactPath(root: string, target: string): Promise<void> {
  assertInside(root, target);
  const segments = relative(resolve(root), resolve(target)).split(sep);
  let current = resolve(root);
  for (const segment of ['', ...segments]) {
    if (segment) current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error('Iris Agent cannot branch an artifact through a symbolic link.');
    }
    if (current !== resolve(target) && !metadata.isDirectory()) {
      throw new Error('Iris Agent branch artifact path crosses a non-directory.');
    }
  }
}

async function copyImmutableArtifactFile(source: string, target: string): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Iris Agent branch artifact reference is not a regular file.');
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target, fsConstants.COPYFILE_EXCL);
}

function assertInside(parent: string, target: string): void {
  const rel = relative(resolve(parent), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep)) {
    throw new Error('Iris Agent storage path escaped its project store.');
  }
}

function assertProjectTarget(parent: string, target: string): void {
  const rel = relative(resolve(parent), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep)) {
    throw new Error('Iris Agent effect path escaped its project.');
  }
}

function assertProjectLocation(parent: string, target: string): void {
  const rel = relative(resolve(parent), resolve(target));
  if (rel === '..' || rel.startsWith('..' + sep)) {
    throw new Error('Iris Agent effect parent escaped its project.');
  }
}

function isFileEffectArtifact(value: unknown): value is {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  beforeSha256: string | null;
  afterSha256: string;
} {
  return isRecord(value) && typeof value.path === 'string' &&
    (value.beforeContent === null || typeof value.beforeContent === 'string') &&
    typeof value.afterContent === 'string' &&
    (value.beforeSha256 === null || typeof value.beforeSha256 === 'string') &&
    typeof value.afterSha256 === 'string';
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
