import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { JsonStore } from '../persistence';
import { writeFileAtomic } from '../atomic-write';
import type { AgentHistorySnapshot } from '@shared/agent-protocol';
import type {
  IrisAgentAnchor,
  IrisAgentMessage,
  IrisAgentModelRef,
  IrisAgentFileEffect,
  IrisAgentRequestFacts,
  IrisAgentRuntimeState,
  IrisAgentSessionInfo,
  IrisAgentToolEvent,
  IrisAgentTurn,
  IrisAgentProviderContextBundle,
  IrisAgentProviderContextCall,
  ProjectScope,
} from '@shared/types';
import {
  renderProviderContextCall,
  renderProviderContextIndex,
  sanitizeProviderContextCall,
} from './context-artifact';

export const IRIS_AGENT_SESSION_STORE_VERSION = 5 as const;

interface IrisAgentSessionStoreFile {
  version: typeof IRIS_AGENT_SESSION_STORE_VERSION;
  projectRoot: string;
  sessions: IrisAgentSessionInfo[];
}

export function agentSessionStorePath(userDataPath: string, projectRoot: string): string {
  return join(userDataPath, 'iris-agent-sessions', sha256(projectRoot).slice(0, 16) + '.json');
}

export class IrisAgentSessionStore {
  private readonly store: JsonStore<IrisAgentSessionStoreFile>;
  private file: IrisAgentSessionStoreFile;

  private constructor(
    private readonly projectRoot: string,
    private readonly filePath: string,
    file: IrisAgentSessionStoreFile,
    debounceMs = 150,
  ) {
    this.file = file;
    this.store = new JsonStore(filePath, debounceMs);
  }

  static async load(options: {
    userDataPath: string;
    projectRoot: string;
    debounceMs?: number;
  }): Promise<IrisAgentSessionStore> {
    const filePath = agentSessionStorePath(options.userDataPath, options.projectRoot);
    const json = new JsonStore<IrisAgentSessionStoreFile>(filePath, options.debounceMs ?? 150);
    const loaded = await json.load(defaultFile(options.projectRoot));
    json.destroy();
    const recovered = recoverInterrupted(validateFile(loaded.value, options.projectRoot));
    const sessionStore = new IrisAgentSessionStore(
      options.projectRoot,
      filePath,
      recovered,
      options.debounceMs ?? 150,
    );
    sessionStore.store.set(recovered);
    await sessionStore.store.flush();
    return sessionStore;
  }

  list(scope: ProjectScope): IrisAgentSessionInfo[] {
    return this.file.sessions
      .filter((session) => session.projectRoot === scope.root)
      .map((session) => withGeneration(session, scope.generation));
  }

  get(sessionId: string): IrisAgentSessionInfo | null {
    return cloneSession(this.file.sessions.find((session) => session.id === sessionId) ?? null);
  }

  upsert(session: IrisAgentSessionInfo): IrisAgentSessionInfo {
    const index = this.file.sessions.findIndex((item) => item.id === session.id);
    const previousUpdatedAt = index >= 0 ? this.file.sessions[index]!.updatedAt : 0;
    const previousRevision = index >= 0 ? this.file.sessions[index]!.revision : 0;
    const updated = {
      ...session,
      updatedAt: Math.max(Date.now(), previousUpdatedAt + 1),
      revision: previousRevision + 1,
    };
    const sessions = [...this.file.sessions];
    if (index >= 0) sessions[index] = updated;
    else sessions.push(updated);
    this.file = { ...this.file, sessions };
    this.store.set(this.file);
    return cloneSession(updated)!;
  }

  delete(sessionId: string): void {
    this.file = {
      ...this.file,
      sessions: this.file.sessions.filter((session) => session.id !== sessionId),
    };
    this.store.set(this.file);
  }

  async savePromptSnapshot(sessionId: string, turnId: string, prompt: string): Promise<void> {
    await writeFileAtomic(this.promptSnapshotPath(sessionId, turnId), prompt);
  }

  promptSnapshotPath(sessionId: string, turnId: string): string {
    const projectKey = sha256(this.projectRoot).slice(0, 16);
    const sessionKey = sha256(sessionId).slice(0, 16);
    const turnKey = sha256(turnId).slice(0, 16);
    return join(dirname(this.filePath), 'prompts', projectKey, sessionKey, `${turnKey}.txt`);
  }

  async deleteTurnArtifacts(sessionId: string, turnId: string): Promise<void> {
    await Promise.all([
      rm(this.promptSnapshotPath(sessionId, turnId), { force: true }),
      rm(this.providerContextDir(sessionId, turnId), { recursive: true, force: true }),
    ]);
  }

  async appendProviderContext(
    sessionId: string,
    turnId: string,
    requestId: string,
    call: IrisAgentProviderContextCall,
    assembledInputAvailable = true,
    runtimeIdentity?: NonNullable<IrisAgentProviderContextBundle['runtimeIdentity']>,
  ): Promise<IrisAgentProviderContextBundle> {
    const existing = await this.readProviderContextBundle(sessionId, turnId);
    if (existing && existing.requestId !== requestId) {
      throw new Error('Provider context request correlation does not match the stored bundle.');
    }
    const calls = existing?.calls ?? [];
    const sanitized = sanitizeProviderContextCall(call);
    const duplicate = calls.find((candidate) => candidate.index === sanitized.index);
    if (duplicate) return existing!;
    if (sanitized.index !== calls.length + 1) {
      throw new Error('Provider context calls must be persisted in order.');
    }
    const callBase = `call-${String(sanitized.index - 1).padStart(3, '0')}`;
    const jsonFile = callBase + '.json';
    const textFile = callBase + '.txt';
    const callJson = JSON.stringify(sanitized, null, 2) + '\n';
    const indexedCall = {
      index: sanitized.index,
      capturedAt: sanitized.capturedAt,
      provider: sanitized.provider,
      model: sanitized.model,
      api: sanitized.api,
      jsonFile,
      textFile,
      sha256: sha256(callJson),
    };
    const effectiveRuntimeIdentity = runtimeIdentity ?? existing?.runtimeIdentity;
    const bundle: IrisAgentProviderContextBundle = {
      schemaVersion: 1,
      kind: 'provider-context-bundle',
      sessionId,
      turnId,
      requestId,
      createdAt: existing?.createdAt ?? sanitized.capturedAt,
      assembledInput: { available: assembledInputAvailable, legacy: false },
      contextStage: 'provider-payload',
      compaction: 'disabled',
      ...(effectiveRuntimeIdentity ? { runtimeIdentity: effectiveRuntimeIdentity } : {}),
      calls: [...calls, indexedCall],
    };
    await this.loadIndexedProviderCalls(sessionId, turnId, calls);
    const contextDir = this.providerContextDir(sessionId, turnId);
    await writeFileAtomic(join(contextDir, jsonFile), callJson);
    await writeFileAtomic(join(contextDir, textFile), renderProviderContextCall(sanitized));
    // The index is the commit point: every referenced call and readable view exists first.
    await writeFileAtomic(this.providerContextJsonPath(sessionId, turnId), JSON.stringify(bundle, null, 2) + '\n');
    try {
      await this.refreshProviderContextText(sessionId, turnId);
    } catch {
      // The readable index is derived and will be regenerated when the user opens it.
    }
    return bundle;
  }

  providerContextJsonPath(sessionId: string, turnId: string): string {
    return join(this.providerContextDir(sessionId, turnId), 'index.json');
  }

  providerContextTextPath(sessionId: string, turnId: string): string {
    return join(this.providerContextDir(sessionId, turnId), 'index.txt');
  }

  async readProviderContextBundle(
    sessionId: string,
    turnId: string,
  ): Promise<IrisAgentProviderContextBundle | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.providerContextJsonPath(sessionId, turnId), 'utf8'));
      return isProviderContextBundle(value) ? value : null;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async refreshProviderContextText(sessionId: string, turnId: string): Promise<void> {
    const bundle = await this.readProviderContextBundle(sessionId, turnId);
    if (!bundle) throw new Error('Provider context bundle is unavailable.');
    const calls = await this.loadIndexedProviderCalls(sessionId, turnId, bundle.calls);
    await writeFileAtomic(
      this.providerContextTextPath(sessionId, turnId),
      renderProviderContextIndex(bundle, calls),
    );
  }

  history(sessionId: string): AgentHistorySnapshot {
    const session = this.file.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error('[IrisAgentSessionStore] unknown session ' + sessionId);
    return {
      revision: session.revision,
      anchor: session.anchor,
      messages: session.messages
        .filter((message) =>
          !message.compact &&
          message.turnId !== session.activeTurnId &&
          (message.content.length > 0 || message.providerMessage !== undefined),
        )
        .map((message) => ({
          id: message.id,
          turnId: message.turnId,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          ...(message.providerMessage ? { providerMessage: { ...message.providerMessage } } : {}),
        })),
    };
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }

  destroy(): void {
    this.store.destroy();
  }

  get root(): string {
    return this.projectRoot;
  }

  private artifactPath(sessionId: string, turnId: string, suffix: string): string {
    const projectKey = sha256(this.projectRoot).slice(0, 16);
    const sessionKey = sha256(sessionId).slice(0, 16);
    const turnKey = sha256(turnId).slice(0, 16);
    return join(dirname(this.filePath), 'prompts', projectKey, sessionKey, turnKey + suffix);
  }

  private providerContextDir(sessionId: string, turnId: string): string {
    return this.artifactPath(sessionId, turnId, '.context');
  }

  private async loadIndexedProviderCalls(
    sessionId: string,
    turnId: string,
    calls: IrisAgentProviderContextBundle['calls'],
  ): Promise<IrisAgentProviderContextCall[]> {
    return Promise.all(calls.map(async (indexed) => {
      const raw = await readFile(
        join(this.providerContextDir(sessionId, turnId), indexed.jsonFile),
        'utf8',
      );
      if (sha256(raw) !== indexed.sha256) {
        throw new Error('Stored provider context call hash does not match its index.');
      }
      const value: unknown = JSON.parse(raw);
      if (!isProviderContextCall(value)) throw new Error('Stored provider context call is invalid.');
      return value;
    }));
  }
}

function defaultFile(projectRoot: string): IrisAgentSessionStoreFile {
  return {
    version: IRIS_AGENT_SESSION_STORE_VERSION,
    projectRoot,
    sessions: [],
  };
}

function validateFile(value: unknown, projectRoot: string): IrisAgentSessionStoreFile {
  if (
    !isRecord(value) ||
    (value.version !== 1 &&
      value.version !== 2 &&
      value.version !== 3 &&
      value.version !== 4 &&
      value.version !== IRIS_AGENT_SESSION_STORE_VERSION)
  ) {
    return defaultFile(projectRoot);
  }
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.filter(isSession).map(cloneSession).map(migrateLegacyArtifacts)
    : [];
  return {
    version: IRIS_AGENT_SESSION_STORE_VERSION,
    projectRoot,
    sessions: sessions.filter((session): session is IrisAgentSessionInfo => session !== null),
  };
}

function recoverInterrupted(file: IrisAgentSessionStoreFile): IrisAgentSessionStoreFile {
  return {
    ...file,
    sessions: file.sessions.map((session) => {
      if (!isActiveRuntimeState(session.state)) return session;
      const now = Date.now();
      const stopped = session.state === 'stopping' || session.stopRequestedTurnId === session.activeTurnId;
      const turns = session.turns.map((turn) =>
        turn.id === session.activeTurnId && turn.status === 'running'
          ? {
              ...turn,
              status: stopped ? 'stopped' as const : 'failed' as const,
              completedAt: turn.completedAt ?? now,
              error: turn.error ?? (stopped
                ? 'Stopped by user.'
                : 'Recovered after Iris restarted before the Agent turn settled.'),
            }
          : turn,
      );
      const { stopRequestedTurnId: _stopRequestedTurnId, ...rest } = session;
      return {
        ...rest,
        state: stopped ? 'idle' : 'failed',
        activeTurnId: null,
        updatedAt: now,
        lastError: stopped
          ? 'Stopped by user.'
          : 'Recovered after Iris restarted before the Agent turn settled.',
        turns,
      };
    }),
  };
}

function withGeneration(session: IrisAgentSessionInfo, generation: number): IrisAgentSessionInfo {
  return cloneSession({ ...session, projectGeneration: generation })!;
}

function cloneSession(session: IrisAgentSessionInfo | null): IrisAgentSessionInfo | null {
  if (!session) return null;
  return {
    ...session,
    anchor: { ...session.anchor },
    model: session.model ? { ...session.model } : null,
    messages: session.messages.map((message) => ({
      ...message,
      ...(message.providerMessage ? { providerMessage: { ...message.providerMessage } } : {}),
    })),
    turns: session.turns.map((turn) => ({ ...turn })),
    toolEvents: session.toolEvents.map((event) => ({ ...event })),
    fileEffects: session.fileEffects.map((effect) => ({ ...effect })),
    ...(session.undoReceipts ? { undoReceipts: session.undoReceipts.map((receipt) => ({ ...receipt })) } : {}),
    ...(session.pendingArtifactCleanupTurnIds
      ? { pendingArtifactCleanupTurnIds: [...session.pendingArtifactCleanupTurnIds] }
      : {}),
    requestFacts: session.requestFacts.map((facts) => ({
      ...facts,
      anchor: { ...facts.anchor },
      layerFingerprints: { ...facts.layerFingerprints },
    })),
  };
}

function isSession(value: unknown): value is IrisAgentSessionInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.kind === 'iris-agent' &&
    isAnchor(value.anchor) &&
    (value.model === undefined || value.model === null || isModelRef(value.model)) &&
    (value.parentSessionId === undefined || typeof value.parentSessionId === 'string') &&
    (value.forkedFromTurnId === undefined || typeof value.forkedFromTurnId === 'string') &&
    typeof value.projectRoot === 'string' &&
    typeof value.projectGeneration === 'number' &&
    typeof value.displayName === 'string' &&
    isRuntimeState(value.state) &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    (value.revision === undefined ||
      (typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0)) &&
    (value.workerEpoch === undefined ||
      (typeof value.workerEpoch === 'number' && Number.isSafeInteger(value.workerEpoch) && value.workerEpoch >= 0)) &&
    (typeof value.activeTurnId === 'string' || value.activeTurnId === null) &&
    (value.stopRequestedTurnId === undefined || typeof value.stopRequestedTurnId === 'string') &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage) &&
    Array.isArray(value.turns) &&
    value.turns.every(isTurn) &&
    Array.isArray(value.toolEvents) &&
    value.toolEvents.every(isToolEvent) &&
    Array.isArray(value.fileEffects) &&
    value.fileEffects.every(isFileEffect) &&
    Array.isArray(value.requestFacts) &&
    value.requestFacts.every(isRequestFacts) &&
    (value.undoReceipts === undefined ||
      (Array.isArray(value.undoReceipts) && value.undoReceipts.every(isUndoReceipt))) &&
    (value.pendingArtifactCleanupTurnIds === undefined ||
      (Array.isArray(value.pendingArtifactCleanupTurnIds) &&
        value.pendingArtifactCleanupTurnIds.every((turnId) => typeof turnId === 'string'))) &&
    value.selfHostingEligible === false
  );
}

function isAnchor(value: unknown): value is IrisAgentAnchor {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    (value.kind === 'document' || value.kind === 'workspace')
  );
}

function isModelRef(value: unknown): value is IrisAgentModelRef {
  return (
    isRecord(value) &&
    typeof value.provider === 'string' && value.provider.length > 0 &&
    typeof value.modelId === 'string' && value.modelId.length > 0
  );
}

function isMessage(value: unknown): value is IrisAgentMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.turnId === 'string' &&
    (value.role === 'user' || value.role === 'assistant' || value.role === 'tool') &&
    typeof value.content === 'string' &&
    typeof value.createdAt === 'number' &&
    (value.compact === undefined || typeof value.compact === 'boolean') &&
    (value.providerOnly === undefined || typeof value.providerOnly === 'boolean') &&
    (value.providerMessage === undefined || isRecord(value.providerMessage))
  );
}

function isTurn(value: unknown): value is IrisAgentTurn {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.userMessageId === 'string' &&
    typeof value.requestId === 'string' &&
    (value.retryOfTurnId === undefined || typeof value.retryOfTurnId === 'string') &&
    (value.promptAvailable === undefined || value.promptAvailable === true) &&
    (value.artifactSchemaVersion === undefined || value.artifactSchemaVersion === 1) &&
    (value.assembledInputAvailable === undefined || value.assembledInputAvailable === true) &&
    (value.assembledInputLegacy === undefined || value.assembledInputLegacy === true) &&
    (value.providerContextAvailable === undefined || value.providerContextAvailable === true) &&
    (value.providerCallCount === undefined ||
      (typeof value.providerCallCount === 'number' &&
        Number.isSafeInteger(value.providerCallCount) && value.providerCallCount >= 0)) &&
    (value.status === 'running' ||
      value.status === 'completed' ||
      value.status === 'failed' ||
      value.status === 'stopped' ||
      value.status === 'rewound') &&
    typeof value.createdAt === 'number'
  );
}

function migrateLegacyArtifacts(session: IrisAgentSessionInfo | null): IrisAgentSessionInfo | null {
  if (!session) return null;
  const legacy = session as IrisAgentSessionInfo & { revision?: number; workerEpoch?: number };
  return {
    ...session,
    model: legacy.model ?? null,
    revision: Number.isSafeInteger(legacy.revision) && legacy.revision! >= 0 ? legacy.revision! : 0,
    workerEpoch: Number.isSafeInteger(legacy.workerEpoch) && legacy.workerEpoch! >= 0
      ? legacy.workerEpoch!
      : 0,
    turns: session.turns.map((turn) => {
      if (turn.promptAvailable !== true || turn.assembledInputAvailable === true) return turn;
      const { promptAvailable: _legacy, ...rest } = turn;
      return {
        ...rest,
        artifactSchemaVersion: 1,
        assembledInputAvailable: true,
        assembledInputLegacy: true,
      };
    }),
    toolEvents: session.toolEvents.map((event) =>
      event.name === 'terminal' && event.terminalIntent === undefined
        ? { ...event, terminalIntent: 'unknown' as const }
        : event),
  };
}

function isProviderContextBundle(value: unknown): value is IrisAgentProviderContextBundle {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.kind === 'provider-context-bundle' &&
    typeof value.sessionId === 'string' &&
    typeof value.turnId === 'string' &&
    typeof value.requestId === 'string' &&
    typeof value.createdAt === 'number' &&
    isRecord(value.assembledInput) &&
    typeof value.assembledInput.available === 'boolean' &&
    value.assembledInput.legacy === false &&
    value.contextStage === 'provider-payload' &&
    value.compaction === 'disabled' &&
    (value.runtimeIdentity === undefined || isProviderContextRuntimeIdentity(value.runtimeIdentity)) &&
    Array.isArray(value.calls) &&
    value.calls.every(isProviderContextIndexCall)
  );
}

function isProviderContextRuntimeIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.appVersion === 'string' &&
    typeof value.protocolVersion === 'number' && Number.isSafeInteger(value.protocolVersion) &&
    typeof value.sessionRevision === 'number' && Number.isSafeInteger(value.sessionRevision) &&
    value.sessionRevision >= 0 &&
    typeof value.workerEpoch === 'number' && Number.isSafeInteger(value.workerEpoch) &&
    value.workerEpoch >= 0
  );
}

function isProviderContextIndexCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.index === 'number' &&
    Number.isSafeInteger(value.index) &&
    value.index > 0 &&
    typeof value.capturedAt === 'number' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    typeof value.api === 'string' &&
    typeof value.jsonFile === 'string' && /^call-\d{3}\.json$/u.test(value.jsonFile) &&
    typeof value.textFile === 'string' && /^call-\d{3}\.txt$/u.test(value.textFile) &&
    typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256)
  );
}

function isProviderContextCall(value: unknown): value is IrisAgentProviderContextCall {
  return (
    isRecord(value) &&
    typeof value.index === 'number' &&
    Number.isSafeInteger(value.index) &&
    value.index > 0 &&
    typeof value.capturedAt === 'number' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    typeof value.api === 'string' &&
    isJsonValue(value.payload)
  );
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function isToolEvent(value: unknown): value is IrisAgentToolEvent {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.turnId === 'string' &&
    typeof value.requestId === 'string' &&
    (value.name === 'read' || value.name === 'edit' || value.name === 'write' || value.name === 'terminal') &&
    (value.state === 'running' || value.state === 'completed' || value.state === 'failed') &&
    typeof value.createdAt === 'number' &&
    typeof value.inputSummary === 'string' &&
    (value.operation === undefined ||
      value.operation === 'access' ||
      value.operation === 'readFile' ||
      value.operation === 'writeFile' ||
      value.operation === 'mkdir' ||
      value.operation === 'exec') &&
    (value.terminalIntent === undefined ||
      value.terminalIntent === 'information' ||
      value.terminalIntent === 'operation' ||
      value.terminalIntent === 'unknown') &&
    (value.command === undefined || typeof value.command === 'string') &&
    (value.cwd === undefined || typeof value.cwd === 'string')
  );
}

function isFileEffect(value: unknown): value is IrisAgentFileEffect {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.turnId === 'string' &&
    typeof value.toolCallId === 'string' &&
    typeof value.path === 'string' &&
    (value.kind === 'edit' || value.kind === 'write') &&
    (typeof value.beforeSha256 === 'string' || value.beforeSha256 === null) &&
    typeof value.afterSha256 === 'string' &&
    typeof value.afterContent === 'string' &&
    typeof value.createdAt === 'number'
  );
}

function isRequestFacts(value: unknown): value is IrisAgentRequestFacts {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.turnId === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.promptFingerprint === 'string' &&
    isRecord(value.layerFingerprints) &&
    typeof value.layerFingerprints.agent === 'string' &&
    typeof value.layerFingerprints.software === 'string' &&
    typeof value.layerFingerprints.project === 'string' &&
    typeof value.layerFingerprints.anchor === 'string' &&
    isAnchor(value.anchor) &&
    typeof value.promptChars === 'number' &&
    value.redacted === true
  );
}

function isUndoReceipt(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.commandId === 'string' &&
    typeof value.removedTurnId === 'string' &&
    typeof value.removedAt === 'number' &&
    typeof value.resultingRevision === 'number' &&
    Number.isSafeInteger(value.resultingRevision) &&
    value.resultingRevision >= 0 &&
    value.externalEffectsRetained === true
  );
}

function isRuntimeState(value: unknown): value is IrisAgentRuntimeState {
  return (
    value === 'starting' ||
    value === 'ready' ||
    value === 'running' ||
    value === 'waiting-tool' ||
    value === 'stopping' ||
    value === 'idle' ||
    value === 'failed'
  );
}

function isActiveRuntimeState(value: IrisAgentRuntimeState): boolean {
  return value === 'starting' || value === 'running' || value === 'waiting-tool' || value === 'stopping';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
