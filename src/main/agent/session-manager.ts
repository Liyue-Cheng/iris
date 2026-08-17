import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ProjectManager } from '../project-manager';
import { assembleAgentPrompt } from './prompt';
import { AgentWorkerHost } from './worker-host';
import { irisPiAgentDir } from './pi-adapter';
import { IrisAgentSessionStore } from './session-store';
import {
  assertIrisAgentExpectedRevision,
  assertQuiescentIrisAgentSession,
  assertUndoableLatestIrisAgentTurn,
  matchesActiveIrisAgentTurn,
  settleIrisAgentTurnDomain,
  undoLatestIrisAgentTurn,
} from './session-domain';
import { IrisAgentToolHost } from './tool-host';
import type {
  AgentSessionRuntimeState,
  AgentToolOperationInput,
  AgentWorkerEvent,
} from '@shared/agent-protocol';
import type { AgentWorkerPort } from './worker-host';
import type {
  IrisAgentAnchor,
  IrisAgentListSnapshot,
  IrisAgentMessage,
  IrisAgentRequestFacts,
  IrisAgentRuntimeState,
  IrisAgentSessionChangedPayload,
  IrisAgentSessionDestroyedPayload,
  IrisAgentSessionInfo,
  IrisAgentToolEvent,
  IrisAgentTurn,
  ProjectScope,
} from '@shared/types';
import { SOFTWARE_PROMPT_TEMPLATE } from '../iris-templates';

interface LoadedStore {
  root: string;
  store: IrisAgentSessionStore;
}

export interface CreateIrisAgentSessionInput {
  anchor: IrisAgentAnchor;
  scope: ProjectScope;
}

export interface IrisAgentSessionManagerOptions {
  workerFactory?: () => AgentWorkerPort;
  workerIdleTimeoutMs?: number;
}

export interface IrisAgentCommandPrecondition {
  commandId?: string;
  expectedRevision?: number;
}

export class IrisAgentSessionManager extends EventEmitter {
  private loaded: LoadedStore | null = null;
  private readonly hosts = new Map<string, AgentWorkerHost>();
  private currentScope: ProjectScope | null = null;
  private readonly workerEventChains = new Map<string, Promise<void>>();
  private readonly sessionCommandChains = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly userDataPath: string,
    private readonly projectManager: ProjectManager,
    private readonly options: IrisAgentSessionManagerOptions = {},
  ) {
    super();
  }

  async list(scope: ProjectScope): Promise<IrisAgentListSnapshot> {
    this.currentScope = scope;
    const store = await this.ensureStore(scope.root);
    for (const session of store.list(scope)) {
      if (session.pendingArtifactCleanupTurnIds?.length) {
        await this.cleanupPendingArtifacts(store, session);
      }
    }
    return { scope, sessions: store.list(scope) };
  }

  async createSession(input: CreateIrisAgentSessionInput): Promise<IrisAgentSessionInfo> {
    this.currentScope = input.scope;
    const store = await this.ensureStore(input.scope.root);
    await this.verifyAnchor(input.anchor);
    const now = Date.now();
    const session: IrisAgentSessionInfo = {
      id: randomUUID(),
      kind: 'iris-agent',
      anchor: input.anchor,
      projectRoot: input.scope.root,
      projectGeneration: input.scope.generation,
      displayName: 'Iris Agent',
      state: 'ready',
      createdAt: now,
      updatedAt: now,
      revision: 0,
      workerEpoch: 0,
      activeTurnId: null,
      messages: [],
      turns: [],
      toolEvents: [],
      fileEffects: [],
      requestFacts: [],
      selfHostingEligible: false,
    };
    const saved = store.upsert(session);
    this.emitChanged(input.scope, saved);
    return saved;
  }

  async send(
    scope: ProjectScope,
    sessionId: string,
    message: string,
    precondition: IrisAgentCommandPrecondition = {},
  ): Promise<IrisAgentSessionInfo> {
    return this.runSessionCommand(sessionId, () =>
      this.sendSession(scope, sessionId, message, precondition));
  }

  private async sendSession(
    scope: ProjectScope,
    sessionId: string,
    message: string,
    precondition: IrisAgentCommandPrecondition = {},
  ): Promise<IrisAgentSessionInfo> {
    this.currentScope = scope;
    const store = await this.ensureStore(scope.root);
    const session = await this.requireSession(scope, sessionId);
    assertIrisAgentExpectedRevision(session, precondition.expectedRevision);
    if (!isStoppedState(session.state)) {
      throw new Error('Iris Agent session is already running.');
    }
    return this.startTurn(scope, store, session, message);
  }

  private async startTurn(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: IrisAgentSessionInfo,
    message: string,
    retryOfTurnId?: string,
  ): Promise<IrisAgentSessionInfo> {
    const prepared = await this.preparePrompt(session, message);
    let assembledInputAvailable = false;
    try {
      await store.savePromptSnapshot(session.id, prepared.turnId, prepared.prompt);
      assembledInputAvailable = true;
    } catch {
      // Artifact persistence is optional and must not prevent the Agent turn.
    }
    if (this.shuttingDown) throw new Error('Iris Agent manager is shutting down.');
    const now = Date.now();
    const userMessage: IrisAgentMessage = {
      id: randomUUID(),
      turnId: prepared.turnId,
      role: 'user',
      content: message,
      createdAt: now,
    };
    const assistantMessage: IrisAgentMessage = {
      id: randomUUID(),
      turnId: prepared.turnId,
      role: 'assistant',
      content: '',
      createdAt: now,
    };
    const turn: IrisAgentTurn = {
      id: prepared.turnId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      requestId: prepared.requestId,
      ...(retryOfTurnId ? { retryOfTurnId } : {}),
      ...(assembledInputAvailable
        ? { artifactSchemaVersion: 1 as const, assembledInputAvailable: true as const }
        : {}),
      status: 'running',
      createdAt: now,
    };
    const running = store.upsert({
      ...session,
      state: 'running',
      activeTurnId: prepared.turnId,
      messages: [...session.messages, userMessage, assistantMessage],
      turns: [...session.turns, turn],
      requestFacts: [...session.requestFacts, prepared.facts],
      lastError: '',
    });
    await store.flush();
    this.emitChanged(scope, running);
    const host = this.hostFor(running, store);
    const correlation = {
      sessionId: session.id,
      workerEpoch: host.workerEpoch,
      requestId: prepared.requestId,
      turnId: prepared.turnId,
    };
    try {
      await host.post({
        type: 'run',
        correlation,
        prompt: prepared.prompt,
      });
    } catch (error) {
      await this.markFailed(
        session.id,
        error instanceof Error ? error.message : String(error),
        correlation,
      );
      throw error;
    }
    return running;
  }

  async stop(scope: ProjectScope, sessionId: string): Promise<IrisAgentSessionInfo> {
    return this.runSessionCommand(sessionId, () => this.stopSession(scope, sessionId));
  }

  private async stopSession(scope: ProjectScope, sessionId: string): Promise<IrisAgentSessionInfo> {
    this.currentScope = scope;
    const store = await this.ensureStore(scope.root);
    const session = await this.requireSession(scope, sessionId);
    const activeTurnId = session.activeTurnId;
    if (!activeTurnId) return session;
    if (session.stopRequestedTurnId === activeTurnId) return session;
    const turn = session.turns.find((candidate) => candidate.id === activeTurnId);
    if (!turn || turn.status !== 'running') return session;
    const stopping = store.upsert({
      ...session,
      state: 'stopping',
      stopRequestedTurnId: activeTurnId,
    });
    this.emitChanged(scope, stopping);
    await store.flush();
    const host = this.hosts.get(sessionId);
    if (!host?.running) {
      return this.settleActiveTurn(scope, store, stopping, {
        sessionId,
        workerEpoch: session.workerEpoch,
        requestId: turn.requestId,
        turnId: turn.id,
      }, 'stopped', 'Stopped by user.');
    }
    const correlation = {
      sessionId,
      workerEpoch: session.workerEpoch,
      requestId: turn.requestId,
      turnId: turn.id,
    };
    try {
      await host.post({ type: 'abort', correlation, reason: 'user' });
    } catch {
      return this.settleActiveTurn(
        scope,
        store,
        store.get(sessionId) ?? stopping,
        correlation,
        'stopped',
        'Stopped by user.',
      );
    }
    return store.get(sessionId) ?? stopping;
  }

  async retry(
    scope: ProjectScope,
    sessionId: string,
    precondition: IrisAgentCommandPrecondition = {},
  ): Promise<IrisAgentSessionInfo> {
    return this.runSessionCommand(sessionId, () => this.retrySession(scope, sessionId, precondition));
  }

  private async retrySession(
    scope: ProjectScope,
    sessionId: string,
    precondition: IrisAgentCommandPrecondition,
  ): Promise<IrisAgentSessionInfo> {
    this.currentScope = scope;
    const store = await this.ensureStore(scope.root);
    const session = await this.requireSession(scope, sessionId);
    assertIrisAgentExpectedRevision(session, precondition.expectedRevision);
    assertQuiescentIrisAgentSession(session);
    const retryTurn = session.turns[session.turns.length - 1];
    if (!retryTurn || (retryTurn.status !== 'failed' && retryTurn.status !== 'stopped')) {
      throw new Error('Only the latest failed or stopped Iris Agent turn can be retried.');
    }
    const userMessage = session.messages.find((message) => message.id === retryTurn.userMessageId);
    if (!userMessage) throw new Error('Retry source message is missing.');

    const host = this.hosts.get(sessionId);
    if (host) this.hosts.delete(sessionId);
    await host?.shutdown();
    await this.drainWorkerEvents(sessionId);

    const latest = await this.requireSession(scope, sessionId);
    assertQuiescentIrisAgentSession(latest);
    const latestTurn = latest.turns[latest.turns.length - 1];
    if (
      latestTurn?.id !== retryTurn.id ||
      (latestTurn.status !== 'failed' && latestTurn.status !== 'stopped')
    ) {
      throw new Error('The Iris Agent retry source changed before retry could start.');
    }
    const prefix = undoLatestIrisAgentTurn(
      latest,
      precondition.commandId ?? randomUUID(),
    );
    const running = await this.startTurn(scope, store, prefix, userMessage.content, retryTurn.id);
    const cleaned = await this.cleanupPendingArtifacts(store, running);
    this.emitChanged(scope, cleaned);
    return cleaned;
  }

  async rewind(
    scope: ProjectScope,
    sessionId: string,
    precondition: IrisAgentCommandPrecondition = {},
  ): Promise<IrisAgentSessionInfo> {
    return this.runSessionCommand(sessionId, () => this.rewindSession(scope, sessionId, precondition));
  }

  private async rewindSession(
    scope: ProjectScope,
    sessionId: string,
    precondition: IrisAgentCommandPrecondition,
  ): Promise<IrisAgentSessionInfo> {
    this.currentScope = scope;
    const store = await this.ensureStore(scope.root);
    const session = await this.requireSession(scope, sessionId);
    assertIrisAgentExpectedRevision(session, precondition.expectedRevision);
    assertQuiescentIrisAgentSession(session);
    assertUndoableLatestIrisAgentTurn(session);

    const host = this.hosts.get(sessionId);
    if (host) this.hosts.delete(sessionId);
    await host?.shutdown();
    await this.drainWorkerEvents(sessionId);

    const latest = await this.requireSession(scope, sessionId);
    assertQuiescentIrisAgentSession(latest);
    assertUndoableLatestIrisAgentTurn(latest);
    let rewound = store.upsert(undoLatestIrisAgentTurn(
      latest,
      precondition.commandId ?? randomUUID(),
    ));
    await store.flush();
    rewound = await this.cleanupPendingArtifacts(store, rewound);
    this.emitChanged(scope, rewound);
    return rewound;
  }

  async getTurnArtifactPath(
    scope: ProjectScope,
    sessionId: string,
    turnId: string,
  ): Promise<string> {
    const store = await this.ensureStore(scope.root);
    const session = await this.requireSession(scope, sessionId);
    const turn = session.turns.find((candidate) => candidate.id === turnId);
    if (!turn) throw new Error('The Iris Agent turn was not found.');
    if (turn.providerContextAvailable === true) {
      await store.refreshProviderContextText(sessionId, turnId);
      return store.providerContextTextPath(sessionId, turnId);
    }
    if (turn.assembledInputAvailable === true || turn.promptAvailable === true) {
      return store.promptSnapshotPath(sessionId, turnId);
    }
    throw new Error('No context artifact is available for this Iris Agent turn.');
  }

  async closeSession(scope: ProjectScope, sessionId: string): Promise<void> {
    await this.runSessionCommand(sessionId, () => this.closeSessionNow(scope, sessionId));
  }

  private async closeSessionNow(scope: ProjectScope, sessionId: string): Promise<void> {
    const store = await this.ensureStore(scope.root);
    const host = this.hosts.get(sessionId);
    if (host) this.hosts.delete(sessionId);
    await host?.shutdown();
    await this.drainWorkerEvents(sessionId);
    store.delete(sessionId);
    this.emit('sessionDestroyed', { scope, sessionId } satisfies IrisAgentSessionDestroyedPayload);
  }

  async closeProject(scope: ProjectScope): Promise<void> {
    const store = await this.ensureStore(scope.root);
    const sessions = store.list(scope);
    await Promise.allSettled(
      sessions.map((session) => this.runSessionCommand(session.id, async () => {
        const host = this.hosts.get(session.id);
        if (host) this.hosts.delete(session.id);
        await host?.shutdown('shutdown');
        await this.drainWorkerEvents(session.id);
      })),
    );
    await store.flush();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const pendingCommands = [...this.sessionCommandChains.values()];
    await Promise.allSettled([...this.hosts.values()].map((host) => host.shutdown('shutdown')));
    await Promise.allSettled(pendingCommands);
    await Promise.allSettled([...this.hosts.values()].map((host) => host.shutdown('shutdown')));
    this.hosts.clear();
    this.workerEventChains.clear();
    this.sessionCommandChains.clear();
    await this.loaded?.store.flush();
    this.loaded?.store.destroy();
    this.loaded = null;
  }

  private async preparePrompt(session: IrisAgentSessionInfo, userMessage: string): Promise<{
    prompt: string;
    turnId: string;
    requestId: string;
    facts: IrisAgentRequestFacts;
  }> {
    await this.projectManager.assertProjectSettingsReady();
    const promptState = await this.projectManager.softwarePromptState();
    const anchorText = await this.readAnchorText(session.anchor);
    const assembled = assembleAgentPrompt({
      software: SOFTWARE_PROMPT_TEMPLATE,
      project: promptState.project.text,
      anchor: 'path' in anchorText
        ? { path: anchorText.path, text: anchorText.text }
        : { workspacePath: anchorText.workspacePath, text: anchorText.text },
    });
    const turnId = randomUUID();
    const requestId = randomUUID();
    const prompt = assembled.text + '\n\n<user-request>\n' + userMessage + '\n</user-request>';
    return {
      prompt,
      turnId,
      requestId,
      facts: {
        id: requestId,
        turnId,
        createdAt: Date.now(),
        promptFingerprint: assembled.fingerprint,
        layerFingerprints: assembled.layerFingerprints,
        anchor: session.anchor,
        promptChars: prompt.length,
        redacted: true,
      },
    };
  }

  private async readAnchorText(anchor: IrisAgentAnchor): Promise<
    | { path: string; text: string }
    | { workspacePath: string; text: string }
  > {
    if (anchor.kind === 'document') {
      try {
        const doc = await this.projectManager.readDoc(anchor.path);
        return { path: doc.path, text: doc.raw };
      } catch (err) {
        throw new Error('anchor-missing: ' + (err instanceof Error ? err.message : String(err)));
      }
    }
    return {
      workspacePath: anchor.path,
      text: 'Workspace anchor: ' + anchor.path + '\nFOCUS_DOC is unset. Read files explicitly before editing.',
    };
  }

  private hostFor(session: IrisAgentSessionInfo, store: IrisAgentSessionStore): AgentWorkerHost {
    const existing = this.hosts.get(session.id);
    if (existing) return existing;
    const withEpoch = store.upsert({ ...session, workerEpoch: session.workerEpoch + 1 });
    if (this.currentScope) this.emitChanged(this.currentScope, withEpoch);
    const host = new AgentWorkerHost(session.id, {
      loadHistory: async (sessionId) => store.history(sessionId),
      loadRuntime: async () => ({ cwd: session.projectRoot, agentDir: irisPiAgentDir() }),
      workerEpoch: withEpoch.workerEpoch,
      ...(this.options.workerFactory ? { workerFactory: this.options.workerFactory } : {}),
      ...(this.options.workerIdleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: this.options.workerIdleTimeoutMs }),
    });
    host.on('event', (event: AgentWorkerEvent) => {
      if (this.hosts.get(session.id) !== host) return;
      this.enqueueWorkerEvent(event);
    });
    host.on('workerError', (err: Error) => {
      if (this.hosts.get(session.id) === host) void this.markFailed(session.id, err.message);
    });
    host.on('crash', (code: number) => {
      if (this.hosts.get(session.id) === host) {
        void this.markFailed(session.id, 'Iris Agent Worker crashed with code ' + String(code));
      }
    });
    this.hosts.set(session.id, host);
    return host;
  }

  private enqueueWorkerEvent(event: AgentWorkerEvent): void {
    const sessionId = event.correlation.sessionId;
    const previous = this.workerEventChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(() => this.handleWorkerEvent(event))
      .catch((error) => this.markFailed(
        sessionId,
        error instanceof Error ? error.message : String(error),
        event.correlation,
      ));
    this.workerEventChains.set(sessionId, next);
    void next.finally(() => {
      if (this.workerEventChains.get(sessionId) === next) this.workerEventChains.delete(sessionId);
    });
  }

  private async handleWorkerEvent(event: AgentWorkerEvent): Promise<void> {
    const scope = this.currentScope;
    if (!scope) return;
    const store = await this.ensureStore(scope.root);
    const session = store.get(event.correlation.sessionId);
    if (!session) return;
    if (event.correlation.workerEpoch !== session.workerEpoch) return;
    if (event.type === 'state') {
      this.updateRuntimeState(scope, store, session, event.state, event.correlation);
      return;
    }
    if (event.type === 'failure') {
      await this.markFailed(session.id, event.message, event.correlation);
      return;
    }
    if (event.type === 'ready') {
      if (!session.activeTurnId) {
        this.emitChanged(scope, store.upsert({ ...session, state: 'ready' }));
      }
      return;
    }
    if (event.type === 'stream') {
      this.applyStreamEvent(scope, store, session, event.event, event.correlation);
      return;
    }
    if (event.type === 'provider-context') {
      try {
        await this.persistProviderContext(scope, store, session, event);
      } catch {
        // Provider capture is diagnostic and cannot change turn execution semantics.
      }
      return;
    }
    if (event.type === 'tool-request') {
      await this.handleToolRequest(scope, store, session, event);
      return;
    }
    if (event.type === 'stopped') {
      this.updateRuntimeState(scope, store, session, 'idle', event.correlation);
    }
  }

  private async persistProviderContext(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: IrisAgentSessionInfo,
    event: Extract<AgentWorkerEvent, { type: 'provider-context' }>,
  ): Promise<void> {
    const { requestId, turnId } = event.correlation;
    if (!requestId || !turnId) return;
    const turn = session.turns.find((candidate) => candidate.id === turnId);
    if (!turn || turn.requestId !== requestId) return;
    const bundle = await store.appendProviderContext(
      session.id,
      turnId,
      requestId,
      event.call,
      turn.assembledInputAvailable === true,
    );
    const latest = store.get(session.id) ?? session;
    const updated = store.upsert({
      ...latest,
      turns: latest.turns.map((candidate) => candidate.id === turnId
        ? {
            ...candidate,
            artifactSchemaVersion: 1,
            providerContextAvailable: true,
            providerCallCount: bundle.calls.length,
          }
        : candidate),
    });
    this.emitChanged(scope, updated);
  }

  private async handleToolRequest(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: IrisAgentSessionInfo,
    event: Extract<AgentWorkerEvent, { type: 'tool-request' }>,
  ): Promise<void> {
    const correlation = event.correlation;
    if (!correlation.requestId || !correlation.turnId || !correlation.toolCallId) return;
    if (!matchesActiveIrisAgentTurn(session, correlation)) return;
    const host = new IrisAgentToolHost({
      projectRoot: scope.root,
      outputRoot: join(this.userDataPath, 'iris-agent-output'),
    });
    const initialToolEvent: IrisAgentToolEvent = {
      id: correlation.toolCallId,
      turnId: correlation.turnId,
      requestId: correlation.requestId,
      name: toolName(event.input),
      state: 'running',
      createdAt: Date.now(),
      inputSummary: compactToolInput(event.input),
    };
    this.emitChanged(scope, store.upsert({
      ...session,
      state: 'waiting-tool',
      toolEvents: [...session.toolEvents, initialToolEvent],
    }));
    const executed = await host.execute(event.input, {
      sessionId: correlation.sessionId,
      requestId: correlation.requestId,
      turnId: correlation.turnId,
      toolCallId: correlation.toolCallId,
    });
    const latest = store.get(session.id) ?? session;
    const toolEvents = latest.toolEvents.map((toolEvent) =>
      toolEvent.id === executed.event.id ? executed.event : toolEvent,
    );
    const fileEffects = executed.fileEffect
      ? [...latest.fileEffects, executed.fileEffect]
      : latest.fileEffects;
    this.emitChanged(scope, store.upsert({
      ...latest,
      state: executed.event.state === 'failed' && !latest.stopRequestedTurnId
        ? 'running'
        : latest.state,
      toolEvents,
      fileEffects,
    }));
    await this.hosts.get(session.id)?.post(
      executed.event.state === 'failed'
        ? {
            type: 'tool-result',
            correlation,
            ok: false,
            error: executed.event.error ?? 'Iris Agent tool failed',
          }
        : {
            type: 'tool-result',
            correlation,
            ok: true,
            result: executed.result,
          },
    );
  }

  private applyStreamEvent(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: IrisAgentSessionInfo,
    event: unknown,
    correlation: AgentWorkerEvent['correlation'],
  ): void {
    const latest = store.get(session.id) ?? session;
    if (!matchesActiveIrisAgentTurn(latest, correlation)) return;
    const withProviderMessage = this.applyProviderMessage(latest, event, correlation.turnId!);
    if (withProviderMessage !== latest) {
      session = store.upsert(withProviderMessage);
      this.emitChanged(scope, session);
    } else {
      session = latest;
    }
    const delta = textDelta(event);
    if (delta) {
      const updated = this.updateAssistantMessage(session, (content) => content + delta);
      this.emitChanged(scope, store.upsert(updated));
      return;
    }
    const providerError = providerStopError(event);
    if (providerError) {
      this.settleActiveTurn(scope, store, session, correlation, 'failed', providerError);
      return;
    }
    if (isEventType(event, 'agent_end') || isEventType(event, 'agent_settled')) {
      this.settleActiveTurn(scope, store, session, correlation, 'completed');
    }
  }

  private applyProviderMessage(
    session: IrisAgentSessionInfo,
    event: unknown,
    turnId: string,
  ): IrisAgentSessionInfo {
    const providerMessage = providerMessageFromEvent(event);
    if (!providerMessage) return session;
    return applyIrisAgentProviderMessage(session, providerMessage, turnId);
  }

  private updateAssistantMessage(
    session: IrisAgentSessionInfo,
    update: (content: string) => string,
  ): IrisAgentSessionInfo {
    const activeTurnId = session.activeTurnId;
    if (!activeTurnId) return session;
    const assistantMessageId = session.turns.find((turn) => turn.id === activeTurnId)
      ?.assistantMessageId;
    if (!assistantMessageId) return session;
    return {
      ...session,
      messages: session.messages.map((message) =>
        message.id === assistantMessageId
          ? { ...message, content: update(message.content) }
          : message,
      ),
    };
  }

  private settleActiveTurn(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: IrisAgentSessionInfo,
    correlation: AgentWorkerEvent['correlation'],
    requestedStatus: 'completed' | 'failed' | 'stopped',
    message?: string,
  ): IrisAgentSessionInfo {
    const latest = store.get(session.id) ?? session;
    const settled = settleIrisAgentTurnDomain(latest, correlation, requestedStatus, message);
    if (settled === latest) return latest;
    const saved = store.upsert(settled);
    this.hosts.get(latest.id)?.markIdle();
    this.emitChanged(scope, saved);
    return saved;
  }

  private updateRuntimeState(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: IrisAgentSessionInfo,
    state: AgentSessionRuntimeState,
    correlation: AgentWorkerEvent['correlation'],
  ): void {
    if (state === 'interrupted') {
      this.settleActiveTurn(scope, store, session, correlation, 'stopped', 'Stopped by user.');
      return;
    }
    if (correlation.turnId && !matchesActiveIrisAgentTurn(session, correlation)) return;
    if (session.activeTurnId && !matchesActiveIrisAgentTurn(session, correlation)) return;
    if (session.stopRequestedTurnId === session.activeTurnId) return;
    if (state === 'idle' && session.activeTurnId) return;
    const mapped = mapRuntimeState(state);
    if (!mapped) return;
    this.emitChanged(scope, store.upsert({ ...session, state: mapped }));
  }

  private async markFailed(
    sessionId: string,
    message: string,
    correlation?: AgentWorkerEvent['correlation'],
  ): Promise<void> {
    const scope = this.currentScope;
    if (!scope) return;
    const store = await this.ensureStore(scope.root);
    const session = store.get(sessionId);
    if (!session) return;
    const activeTurn = session.turns.find((turn) => turn.id === session.activeTurnId);
    const effectiveCorrelation = correlation ?? {
      sessionId,
      workerEpoch: session.workerEpoch,
      ...(activeTurn ? { requestId: activeTurn.requestId, turnId: activeTurn.id } : {}),
    };
    this.settleActiveTurn(scope, store, session, effectiveCorrelation, 'failed', message);
  }

  private async requireSession(scope: ProjectScope, sessionId: string): Promise<IrisAgentSessionInfo> {
    const store = await this.ensureStore(scope.root);
    const session = store.get(sessionId);
    if (!session || session.projectRoot !== scope.root) {
      throw new Error('Iris Agent session is outside the active project scope.');
    }
    if (session.projectGeneration !== scope.generation) {
      return store.upsert({ ...session, projectGeneration: scope.generation });
    }
    return session;
  }

  private async cleanupPendingArtifacts(
    store: IrisAgentSessionStore,
    session: IrisAgentSessionInfo,
  ): Promise<IrisAgentSessionInfo> {
    const pending = [...new Set(session.pendingArtifactCleanupTurnIds ?? [])];
    if (pending.length === 0) return store.get(session.id) ?? session;
    const remaining: string[] = [];
    for (const turnId of pending) {
      try {
        await store.deleteTurnArtifacts(session.id, turnId);
      } catch {
        remaining.push(turnId);
      }
    }
    const latest = store.get(session.id) ?? session;
    if (remaining.length === pending.length) return latest;
    const cleaned = store.upsert({
      ...latest,
      pendingArtifactCleanupTurnIds: remaining,
    });
    await store.flush();
    return cleaned;
  }

  private async verifyAnchor(anchor: IrisAgentAnchor): Promise<void> {
    if (anchor.kind === 'document') {
      await this.projectManager.readDoc(anchor.path);
    }
  }

  private async ensureStore(projectRoot: string): Promise<IrisAgentSessionStore> {
    if (this.loaded?.root === projectRoot) return this.loaded.store;
    await this.loaded?.store.flush();
    this.loaded?.store.destroy();
    const store = await IrisAgentSessionStore.load({
      userDataPath: this.userDataPath,
      projectRoot,
    });
    this.loaded = { root: projectRoot, store };
    return store;
  }

  private async drainWorkerEvents(sessionId: string): Promise<void> {
    await this.workerEventChains.get(sessionId)?.catch(() => undefined);
  }

  private runSessionCommand<T>(sessionId: string, command: () => Promise<T>): Promise<T> {
    const previous = this.sessionCommandChains.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => {
      if (this.shuttingDown) throw new Error('Iris Agent manager is shutting down.');
      return command();
    });
    const tail = result.then(() => undefined, () => undefined);
    this.sessionCommandChains.set(sessionId, tail);
    void tail.finally(() => {
      if (this.sessionCommandChains.get(sessionId) === tail) {
        this.sessionCommandChains.delete(sessionId);
      }
    });
    return result;
  }

  private emitChanged(scope: ProjectScope, session: IrisAgentSessionInfo): void {
    this.emit('sessionChanged', { scope, session } satisfies IrisAgentSessionChangedPayload);
  }
}

export function applyIrisAgentProviderMessage(
  session: IrisAgentSessionInfo,
  providerMessage: Record<string, unknown>,
  turnId: string,
): IrisAgentSessionInfo {
  const turn = session.turns.find((candidate) => candidate.id === turnId);
  if (!turn) return session;
  const role = providerMessage.role;
  if (role === 'user') {
    return {
      ...session,
      messages: session.messages.map((message) => message.id === turn.userMessageId
        ? { ...message, providerMessage: { ...providerMessage } }
        : message),
    };
  }
  if (role === 'assistant') {
    const toolCallIds = providerAssistantToolCallIds(providerMessage);
    if (providerMessage.stopReason === 'toolUse' && toolCallIds.length > 0) {
      const id = `pi-assistant:${turnId}:${toolCallIds.map(encodeURIComponent).join(',')}`;
      if (session.messages.some((message) => message.id === id)) return session;
      return {
        ...session,
        messages: insertBeforeMessage(session.messages, turn.assistantMessageId, {
          id,
          turnId,
          role: 'assistant',
          content: providerMessageText(providerMessage) ?? '',
          createdAt: typeof providerMessage.timestamp === 'number'
            ? providerMessage.timestamp
            : Date.now(),
          providerOnly: true,
          providerMessage: { ...providerMessage },
        }),
      };
    }
    const content = providerMessageText(providerMessage);
    return {
      ...session,
      messages: session.messages.map((message) => message.id === turn.assistantMessageId
        ? {
            ...message,
            ...(content !== null ? { content } : {}),
            providerMessage: { ...providerMessage },
          }
        : message),
    };
  }
  if (role !== 'toolResult') return session;
  const toolCallId = typeof providerMessage.toolCallId === 'string'
    ? providerMessage.toolCallId
    : randomUUID();
  const id = `pi-tool:${turnId}:${toolCallId}`;
  if (session.messages.some((message) => message.id === id)) return session;
  return {
    ...session,
    messages: insertBeforeMessage(session.messages, turn.assistantMessageId, {
      id,
      turnId,
      role: 'tool',
      content: providerMessageText(providerMessage) ?? '',
      createdAt: typeof providerMessage.timestamp === 'number'
        ? providerMessage.timestamp
        : Date.now(),
      providerMessage: { ...providerMessage },
    }),
  };
}

function insertBeforeMessage(
  messages: IrisAgentSessionInfo['messages'],
  beforeId: string | undefined,
  message: IrisAgentSessionInfo['messages'][number],
): IrisAgentSessionInfo['messages'] {
  const index = beforeId ? messages.findIndex((candidate) => candidate.id === beforeId) : -1;
  if (index < 0) return [...messages, message];
  return [...messages.slice(0, index), message, ...messages.slice(index)];
}

function providerAssistantToolCallIds(message: Record<string, unknown>): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((block) =>
    isRecord(block) && block.type === 'toolCall' && typeof block.id === 'string'
      ? [block.id]
      : []);
}

function mapRuntimeState(state: AgentSessionRuntimeState): IrisAgentRuntimeState | null {
  if (state === 'interrupted') return 'idle';
  if (state === 'starting' || state === 'ready' || state === 'running' || state === 'waiting-tool' || state === 'stopping' || state === 'idle' || state === 'failed') {
    return state;
  }
  return null;
}

function isStoppedState(state: IrisAgentRuntimeState): boolean {
  return state === 'ready' || state === 'idle' || state === 'failed';
}

export function applyIrisAgentMessageRewind(
  session: IrisAgentSessionInfo,
  _legacyTargetTurnId?: string,
): IrisAgentSessionInfo {
  return undoLatestIrisAgentTurn(session);
}

export function settleIrisAgentTurn(
  session: IrisAgentSessionInfo,
  correlation: { sessionId: string; workerEpoch?: number; requestId?: string; turnId?: string },
  requestedStatus: 'completed' | 'failed' | 'stopped',
  message?: string,
): IrisAgentSessionInfo {
  return settleIrisAgentTurnDomain(session, correlation, requestedStatus, message);
}

function textDelta(event: unknown): string | null {
  if (!isRecord(event) || event.type !== 'message_update') return null;
  const assistantEvent = event.assistantMessageEvent;
  if (!isRecord(assistantEvent) || assistantEvent.type !== 'text_delta') return null;
  return typeof assistantEvent.delta === 'string' ? assistantEvent.delta : null;
}

function providerStopError(event: unknown): string | null {
  if (isRecord(event) && event.type === 'message_end' && isRecord(event.message)) {
    return event.message.role === 'assistant' && event.message.stopReason === 'error'
      ? (typeof event.message.errorMessage === 'string'
          ? event.message.errorMessage
          : 'Provider returned stopReason=error.')
      : null;
  }
  if (!isRecord(event) || event.type !== 'message_update') return null;
  const assistantEvent = event.assistantMessageEvent;
  if (!isRecord(assistantEvent) || assistantEvent.type !== 'message_end') return null;
  const stopReason = assistantEvent.stopReason;
  return stopReason === 'error' ? 'Provider returned stopReason=error.' : null;
}

function providerMessageFromEvent(event: unknown): Record<string, unknown> | null {
  if (!isRecord(event) || event.type !== 'message_end' || !isRecord(event.message)) return null;
  const role = event.message.role;
  return role === 'user' || role === 'assistant' || role === 'toolResult'
    ? event.message
    : null;
}

function providerMessageText(message: Record<string, unknown>): string | null {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return null;
  return message.content
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .map((part) => {
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isEventType(event: unknown, type: string): boolean {
  return isRecord(event) && event.type === type;
}

function toolName(input: AgentToolOperationInput): IrisAgentToolEvent['name'] {
  return input.tool;
}

function compactToolInput(input: AgentToolOperationInput): string {
  if (input.tool === 'terminal') return input.command.slice(0, 220);
  return (input.operation + ' ' + input.absolutePath).slice(0, 220);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
