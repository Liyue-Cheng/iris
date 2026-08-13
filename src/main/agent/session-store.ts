import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from '../persistence';
import type {
  IrisAgentAnchor,
  IrisAgentMessage,
  IrisAgentFileEffect,
  IrisAgentRequestFacts,
  IrisAgentRuntimeState,
  IrisAgentSessionInfo,
  IrisAgentToolEvent,
  IrisAgentTurn,
  ProjectScope,
} from '@shared/types';

export const IRIS_AGENT_SESSION_STORE_VERSION = 1 as const;

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
    filePath: string,
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
    const updated = { ...session, updatedAt: Date.now() };
    const index = this.file.sessions.findIndex((item) => item.id === session.id);
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

  history(sessionId: string): {
    revision: number;
    anchor: IrisAgentAnchor;
    messages: Array<{ id: string; role: 'user' | 'assistant' | 'tool'; content: string }>;
  } {
    const session = this.file.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error('[IrisAgentSessionStore] unknown session ' + sessionId);
    return {
      revision: session.updatedAt,
      anchor: session.anchor,
      messages: session.messages
        .filter((message) => !message.compact)
        .map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
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
}

function defaultFile(projectRoot: string): IrisAgentSessionStoreFile {
  return {
    version: IRIS_AGENT_SESSION_STORE_VERSION,
    projectRoot,
    sessions: [],
  };
}

function validateFile(value: unknown, projectRoot: string): IrisAgentSessionStoreFile {
  if (!isRecord(value) || value.version !== IRIS_AGENT_SESSION_STORE_VERSION) {
    return defaultFile(projectRoot);
  }
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.filter(isSession).map(cloneSession)
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
      const turns = session.turns.map((turn) =>
        turn.id === session.activeTurnId
          ? {
              ...turn,
              status: 'failed' as const,
              completedAt: turn.completedAt ?? now,
              error: turn.error ?? 'Recovered after Iris restarted before the Agent turn settled.',
            }
          : turn,
      );
      return {
        ...session,
        state: 'failed',
        activeTurnId: null,
        updatedAt: now,
        lastError: 'Recovered after Iris restarted before the Agent turn settled.',
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
    messages: session.messages.map((message) => ({ ...message })),
    turns: session.turns.map((turn) => ({ ...turn })),
    toolEvents: session.toolEvents.map((event) => ({ ...event })),
    fileEffects: session.fileEffects.map((effect) => ({ ...effect })),
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
    typeof value.projectRoot === 'string' &&
    typeof value.projectGeneration === 'number' &&
    typeof value.displayName === 'string' &&
    isRuntimeState(value.state) &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    (typeof value.activeTurnId === 'string' || value.activeTurnId === null) &&
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

function isMessage(value: unknown): value is IrisAgentMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.turnId === 'string' &&
    (value.role === 'user' || value.role === 'assistant' || value.role === 'tool') &&
    typeof value.content === 'string' &&
    typeof value.createdAt === 'number'
  );
}

function isTurn(value: unknown): value is IrisAgentTurn {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.userMessageId === 'string' &&
    typeof value.requestId === 'string' &&
    (value.status === 'running' ||
      value.status === 'completed' ||
      value.status === 'failed' ||
      value.status === 'stopped' ||
      value.status === 'rewound') &&
    typeof value.createdAt === 'number'
  );
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
    typeof value.inputSummary === 'string'
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
