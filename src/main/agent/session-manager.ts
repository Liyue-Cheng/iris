import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ProjectManager } from '../project-manager';
import type { SettingsManager } from '../settings-manager';
import { assembleAgentPrompt } from './prompt';
import { AgentWorkerHost } from './worker-host';
import { irisPiAgentDir, loadIrisModelCatalog, resolveIrisModelBaseUrl } from './pi-adapter';
import { IrisAgentSessionStore } from './session-store';
import {
  abandonOpenAgentTurn,
  assertIrisAgentExpectedRevision,
  assertQuiescentIrisAgentSession,
  assertUndoableLatestIrisAgentTurn,
  completeActiveAgentTurn,
  matchesActiveAgentTurn,
  pauseActiveAgentTurn,
  preparePausedAgentTurnForResume,
  resumePausedAgentTurn,
  undoLatestIrisAgentTurn,
} from './session-domain';
import { IrisAgentToolHost, type IrisAgentToolHostResult } from './tool-host';
import {
  AgentCommandPty,
  resolveAgentCommandShell,
  type AgentCommandPtyEvent,
  type AgentCommandPtyOptions,
} from './command-pty';
import { TerminalMirror } from '../terminal/terminal-mirror';
import { AgentSupervisionLog } from './supervision';
import type {
  AgentProviderProxy,
  AgentCorrelation,
  AgentSessionRuntimeState,
  AgentToolOperationInput,
  AgentWorkerEvent,
  AgentTerminalSupervisionInput,
  AgentTerminalSupervisionResult,
} from '@shared/agent-protocol';
import type { AgentWorkerPort } from './worker-host';
import type {
  IrisAgentAnchor,
  IrisAgentListSnapshot,
  IrisAgentModelCatalog,
  IrisAgentModelRef,
  IrisAgentPauseReason,
  IrisAgentSessionChangedPayload,
  IrisAgentSessionDestroyedPayload,
  IrisAgentSessionInfo,
  IrisAgentTerminalOutputPayload,
  IrisAgentTerminalReplay,
  ProjectScope,
} from '@shared/types';
import type {
  AgentReplyActivity,
  AgentRequestFacts,
  AgentSessionAggregate,
  AgentToolActivity,
} from './session-model';
import {
  cloneAgentSession,
  createEmptyAgentSession,
  currentAgentTurn,
  diffAgentSessionProjection,
  isAgentSessionBusy,
  projectAgentSession,
} from './session-model';
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
  appVersion?: string;
  modelCatalogLoader?: () => Promise<IrisAgentModelCatalog>;
  providerProfileRoot?: string;
  /** Machine-level settings store; persists the user's last selected model. */
  settingsManager?: SettingsManager;
  resolveProxy?: (url: string) => Promise<string>;
  toolExecutor?: (
    input: AgentToolOperationInput,
    correlation: Required<Pick<AgentCorrelation, 'sessionId' | 'turnId' | 'toolCallId' | 'operationId'>>,
  ) => Promise<IrisAgentToolHostResult>;
  terminalFactory?: (options: AgentCommandPtyOptions) => AgentCommandPty;
  terminalDisplayThresholdMs?: number;
  supervisionIntervalMs?: number;
}

export interface IrisAgentCommandPrecondition {
  commandId?: string;
  expectedRevision?: number;
  expectedTurnId?: string;
}

interface PreparedAgentTurn {
  prompt: string;
  turnId: string;
  facts: AgentRequestFacts;
}

export class IrisAgentSessionManager extends EventEmitter {
  private loaded: LoadedStore | null = null;
  private readonly hosts = new Map<string, AgentWorkerHost>();
  private readonly emittedProjections = new Map<string, IrisAgentSessionInfo>();
  private currentScope: ProjectScope | null = null;
  private readonly sessionMutationChains = new Map<string, Promise<void>>();
  private modelCatalogCache: IrisAgentModelCatalog | null = null;
  private modelCatalogLoad: { generation: number; promise: Promise<IrisAgentModelCatalog> } | null = null;
  private modelCatalogGeneration = 0;
  private readonly commandShell = resolveAgentCommandShell(process.env);
  private readonly terminals = new Map<string, {
    sessionId: string;
    terminal: AgentCommandPty;
    outputPath: string;
    cursor: number;
    plainText: string;
    running: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  private readonly pendingSupervisions = new Map<string, {
    sessionId: string;
    workerEpoch: number;
    resolve: (result: AgentTerminalSupervisionResult) => void;
    reject: (error: Error) => void;
  }>();
  private readonly supervisionLog = new AgentSupervisionLog();
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
    const sessions = store.list().map((session) => projectAgentSession(session, scope.generation));
    for (const session of sessions) this.emittedProjections.set(session.id, structuredClone(session));
    return { scope, sessions };
  }

  async createSession(input: CreateIrisAgentSessionInput): Promise<IrisAgentSessionInfo> {
    this.currentScope = input.scope;
    const store = await this.ensureStore(input.scope.root);
    await this.verifyAnchor(input.anchor);
    const preferred = this.options.settingsManager?.get().experimental.irisAgentDefaultModel ?? null;
    const selected = this.modelCatalogCache
      ? this.modelCatalogCache.models.find((candidate) => sameModel(preferred, candidate)) ??
        this.modelCatalogCache.models[0] ?? null
      : preferred;
    const aggregate = createEmptyAgentSession({
      id: randomUUID(),
      anchor: input.anchor,
      model: selected ? { provider: selected.provider, modelId: selected.modelId } : null,
      projectRoot: input.scope.root,
      displayName: 'Iris Agent',
      now: Date.now(),
    });
    const saved = await store.commit(aggregate);
    this.emitChanged(input.scope, saved);
    return projectAgentSession(saved, input.scope.generation);
  }

  async listModels(forceRefresh = false): Promise<IrisAgentModelCatalog> {
    return this.loadModelCatalog(forceRefresh);
  }

  async setModel(
    scope: ProjectScope,
    sessionId: string,
    model: IrisAgentModelRef,
    precondition: IrisAgentCommandPrecondition = {},
  ): Promise<IrisAgentSessionInfo> {
    return this.runSessionCommand(sessionId, async () => {
      this.currentScope = scope;
      const store = await this.ensureStore(scope.root);
      const session = await this.requireSession(scope, sessionId);
      assertIrisAgentExpectedRevision(session, precondition.expectedRevision);
      assertQuiescentIrisAgentSession(session);
      const catalog = await this.loadModelCatalog();
      if (!catalog.models.some((candidate) => sameModel(model, candidate))) {
        throw new Error(`Iris Agent model is unavailable: ${model.provider}/${model.modelId}`);
      }
      this.options.settingsManager?.update({ experimental: { irisAgentDefaultModel: { ...model } } });
      if (sameModel(session.model, model)) return projectAgentSession(session, scope.generation);
      await this.shutdownHost(sessionId);
      const latest = await this.requireSession(scope, sessionId);
      latest.model = { ...model };
      const saved = await store.commit(latest);
      this.emitChanged(scope, saved);
      return projectAgentSession(saved, scope.generation);
    });
  }

  async branch(
    scope: ProjectScope,
    sessionId: string,
    throughTurnId: string,
    precondition: IrisAgentCommandPrecondition = {},
  ): Promise<IrisAgentSessionInfo> {
    return this.runSessionCommand(sessionId, async () => {
      this.currentScope = scope;
      const store = await this.ensureStore(scope.root);
      const source = await this.requireSession(scope, sessionId);
      assertIrisAgentExpectedRevision(source, precondition.expectedRevision);
      const branchNumber = store.list().filter((session) => session.parentSessionId === source.id).length + 1;
      const branch = createIrisAgentBranch(
        source,
        throughTurnId,
        randomUUID(),
        `${source.displayName} Branch ${branchNumber}`,
        Date.now(),
      );
      const saved = await store.commit(branch);
      this.emitChanged(scope, saved);
      return projectAgentSession(saved, scope.generation);
    });
  }

  async send(
    scope: ProjectScope,
    sessionId: string,
    message: string,
    precondition: IrisAgentCommandPrecondition = {},
  ): Promise<IrisAgentSessionInfo> {
    return this.runSessionCommand(sessionId, () => this.sendSession(scope, sessionId, message, precondition));
  }

  private async sendSession(
    scope: ProjectScope,
    sessionId: string,
    message: string,
    precondition: IrisAgentCommandPrecondition,
  ): Promise<IrisAgentSessionInfo> {
    this.currentScope = scope;
    const store = await this.ensureStore(scope.root);
    let session = await this.requireSession(scope, sessionId);
    assertIrisAgentExpectedRevision(session, precondition.expectedRevision);
    this.assertUsableModel(session);
    if (isAgentSessionBusy(session)) throw new Error('Iris Agent session is already running.');
    if (session.state === 'paused') {
      await this.shutdownHost(sessionId);
      session = abandonOpenAgentTurn(await this.requireSession(scope, sessionId));
    }
    const turnId = randomUUID();
    const now = Date.now();
    session.turns.push({
      id: turnId,
      userActivityId: randomUUID(),
      state: 'running',
      assembledInputAvailable: false,
      createdAt: now,
    });
    const turn = session.turns[session.turns.length - 1]!;
    session.timeline.push({
      id: turn.userActivityId,
      ordinal: session.nextOrdinal++,
      turnId,
      kind: 'user',
      content: message,
      assembledInputArtifactId: `assembled-input:${turnId}`,
      createdAt: now,
    });
    session.currentTurnId = turnId;
    session.state = 'starting';
    let running = await store.commit(session);
    this.emitChanged(scope, running);
    try {
      const prepared = await this.preparePrompt(running, message, turnId);
      let assembledInputAvailable = false;
      try {
        await store.savePromptSnapshot(session.id, prepared.turnId, prepared.prompt);
        assembledInputAvailable = true;
      } catch {
        // The run remains valid when only its optional readable artifact cannot be written.
      }
      const host = await this.hostFor(running, store, scope);
      await host.ensureStarted();
      session = await this.requireSession(scope, sessionId);
      const acceptedTurn = session.turns.find((candidate) => candidate.id === turnId);
      if (!acceptedTurn || acceptedTurn.state !== 'running' || session.currentTurnId !== turnId) {
        throw new Error('The Iris Agent Turn changed while its runtime was starting.');
      }
      acceptedTurn.assembledInputAvailable = assembledInputAvailable;
      session.transcript.push({
        id: `turn-input:${prepared.turnId}`,
        turnId,
        role: 'user',
        content: prepared.prompt,
        createdAt: now,
      });
      session.requestFacts.push(prepared.facts);
      session.state = 'running';
      running = await store.commit(session);
      this.emitChanged(scope, running);
      const correlation = activeTurnCorrelation(running, host.workerEpoch);
      await host.post({ type: 'run', correlation, prompt: prepared.prompt });
      return projectAgentSession(store.get(sessionId) ?? running, scope.generation);
    } catch (error) {
      await this.pauseSessionExecution(sessionId, errorMessage(error), undefined, 'runtime');
      throw error;
    }
  }

  async stop(
    scope: ProjectScope,
    sessionId: string,
    precondition: IrisAgentCommandPrecondition = {},
  ): Promise<IrisAgentSessionInfo> {
    return this.runSessionCommand(sessionId, async () => {
      this.currentScope = scope;
      const store = await this.ensureStore(scope.root);
      const session = await this.requireSession(scope, sessionId);
      if (precondition.expectedTurnId !== undefined) {
        if (session.currentTurnId !== precondition.expectedTurnId) {
          throw new Error('The Iris Agent Turn changed before Stop was applied.');
        }
      } else {
        assertIrisAgentExpectedRevision(session, precondition.expectedRevision);
      }
      const turn = currentAgentTurn(session);
      if (!turn || (turn.state !== 'running' && turn.state !== 'pausing')) {
        return projectAgentSession(session, scope.generation);
      }
      if (turn.state !== 'pausing') {
        turn.state = 'pausing';
        session.state = 'stopping';
        session.stopRequestedTurnId = turn.id;
        const stopping = await store.commit(session);
        this.emitChanged(scope, stopping);
      }
      const latest = store.get(sessionId) ?? session;
      const correlation = activeTurnCorrelation(latest, latest.workerEpoch);
      this.abortSessionTerminals(sessionId);
      await this.shutdownHost(sessionId);
      const paused = await this.pauseTurn(
        scope, store, store.get(sessionId) ?? latest, correlation, 'user', 'Paused by user.',
      );
      return projectAgentSession(paused, scope.generation);
    });
  }

  async retry(
    scope: ProjectScope,
    sessionId: string,
    precondition: IrisAgentCommandPrecondition = {},
  ): Promise<IrisAgentSessionInfo> {
    return this.runSessionCommand(sessionId, async () => {
      this.currentScope = scope;
      const store = await this.ensureStore(scope.root);
      let session = await this.requireSession(scope, sessionId);
      assertIrisAgentExpectedRevision(session, precondition.expectedRevision);
      assertQuiescentIrisAgentSession(session);
      const turn = session.turns.find((candidate) => candidate.id === session.currentTurnId);
      if (!turn || turn.state !== 'paused') {
        throw new Error('Only the latest paused Iris Agent turn can continue.');
      }
      const prepared = preparePausedAgentTurnForResume(session);
      if (prepared !== session) {
        session = await store.commit(prepared);
        this.emitChanged(scope, session);
        if (!session.currentTurnId) return projectAgentSession(session, scope.generation);
      }
      this.assertUsableModel(session);
      await this.shutdownHost(sessionId);
      const host = await this.hostFor(session, store, scope);
      await host.ensureStarted();
      session = await this.requireSession(scope, sessionId);
      const latestTurn = session.turns.find((candidate) => candidate.id === turn.id);
      if (!latestTurn || latestTurn.state !== 'paused') throw new Error('The paused turn changed before Continue.');
      const running = await store.commit(resumePausedAgentTurn(session));
      this.emitChanged(scope, running);
      const correlation = activeTurnCorrelation(running, host.workerEpoch);
      try {
        await host.post({
          type: 'resume',
          correlation,
          providerCallOffset: running.providerCalls.length,
        });
      } catch (error) {
        await this.pauseSessionExecution(sessionId, errorMessage(error), correlation, 'runtime');
        throw error;
      }
      return projectAgentSession(store.get(sessionId) ?? running, scope.generation);
    });
  }

  async rewind(
    scope: ProjectScope,
    sessionId: string,
    precondition: IrisAgentCommandPrecondition = {},
  ): Promise<IrisAgentSessionInfo> {
    return this.runSessionCommand(sessionId, async () => {
      this.currentScope = scope;
      const store = await this.ensureStore(scope.root);
      const session = await this.requireSession(scope, sessionId);
      assertIrisAgentExpectedRevision(session, precondition.expectedRevision);
      assertUndoableLatestIrisAgentTurn(session);
      await this.shutdownHost(sessionId);
      const latest = await this.requireSession(scope, sessionId);
      const saved = await store.commit(undoLatestIrisAgentTurn(
        latest,
        precondition.commandId ?? randomUUID(),
      ));
      this.emitChanged(scope, saved);
      return projectAgentSession(saved, scope.generation);
    });
  }

  async getTurnArtifactPath(scope: ProjectScope, sessionId: string, turnId: string): Promise<string> {
    const store = await this.ensureStore(scope.root);
    const session = await this.requireSession(scope, sessionId);
    const turn = session.turns.find((candidate) => candidate.id === turnId && candidate.state !== 'removed');
    if (!turn) throw new Error('The Iris Agent turn was not found.');
    const hasProviderContext = session.providerCalls.some((call) => call.turnId === turnId);
    if (hasProviderContext) {
      await store.refreshProviderContextText(sessionId, turnId);
      return store.providerContextTextPath(sessionId, turnId);
    }
    if (turn.assembledInputAvailable) return store.promptSnapshotPath(sessionId, turnId);
    throw new Error('No context artifact is available for this Iris Agent turn.');
  }

  async replayTerminal(
    scope: ProjectScope,
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<IrisAgentTerminalReplay> {
    const session = await this.requireSession(scope, sessionId);
    const activity = terminalActivity(session, terminalId);
    const artifactRef = activity ? terminalArtifactRef(session, activity) : undefined;
    if (!activity || !artifactRef) throw new Error('Iris Agent terminal was not found.');
    const live = this.terminals.get(terminalId);
    if (live?.sessionId === sessionId) {
      live.terminal.resize(cols, rows);
      return live.terminal.replay();
    }
    const store = await this.ensureStore(scope.root);
    const bytes = await fs.readFile(join(store.artifactRoot(sessionId), ...artifactRef.split('/')));
    const mirror = new TerminalMirror(cols, rows, 5000);
    try {
      mirror.write(bytes.toString('utf8'));
      await mirror.fence(250, () => undefined);
      return { data: Buffer.from(mirror.serialize(5000), 'utf8').toString('base64'), cursor: bytes.length };
    } finally {
      mirror.dispose();
    }
  }

  async writeTerminal(
    scope: ProjectScope,
    sessionId: string,
    terminalId: string,
    data: string,
  ): Promise<void> {
    const session = await this.requireSession(scope, sessionId);
    if (!terminalActivity(session, terminalId)) throw new Error('Iris Agent terminal was not found.');
    const live = this.terminals.get(terminalId);
    if (!live || live.sessionId !== sessionId || !live.running) {
      throw new Error('Iris Agent terminal is no longer running.');
    }
    live.terminal.write(data);
    const activity = terminalActivity(session, terminalId);
    if (activity && !activity.terminalUserInput) {
      activity.terminalUserInput = true;
      await this.commitAndEmit(scope, await this.ensureStore(scope.root), session);
    }
  }

  async resizeTerminal(
    scope: ProjectScope,
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const session = await this.requireSession(scope, sessionId);
    if (!terminalActivity(session, terminalId)) throw new Error('Iris Agent terminal was not found.');
    const live = this.terminals.get(terminalId);
    if (live?.sessionId === sessionId) live.terminal.resize(cols, rows);
  }

  async continueTerminalSupervision(
    scope: ProjectScope,
    sessionId: string,
    terminalId: string,
  ): Promise<IrisAgentSessionInfo> {
    return this.runSessionCommand(sessionId, async () => {
      const store = await this.ensureStore(scope.root);
      const session = await this.requireSession(scope, sessionId);
      if (session.terminalSupervisionAlert?.terminalId !== terminalId) {
        return projectAgentSession(session, scope.generation);
      }
      delete session.terminalSupervisionAlert;
      const saved = await this.commitAndEmit(scope, store, session);
      this.scheduleTerminalSupervision(sessionId, terminalId);
      return projectAgentSession(saved, scope.generation);
    });
  }

  async closeSession(
    scope: ProjectScope,
    sessionId: string,
    precondition: IrisAgentCommandPrecondition = {},
  ): Promise<void> {
    await this.runSessionCommand(sessionId, async () => {
      const store = await this.ensureStore(scope.root);
      const session = await this.requireSession(scope, sessionId);
      assertIrisAgentExpectedRevision(session, precondition.expectedRevision);
      await this.shutdownHost(sessionId);
      this.abortSessionTerminals(sessionId);
      await store.delete(sessionId);
      this.emittedProjections.delete(sessionId);
      this.emit('sessionDestroyed', { scope, sessionId } satisfies IrisAgentSessionDestroyedPayload);
    });
  }

  async closeProject(scope: ProjectScope): Promise<void> {
    const store = await this.ensureStore(scope.root);
    await Promise.allSettled(store.list().map((session) => this.runSessionCommand(session.id, async () => {
      this.abortSessionTerminals(session.id);
      await this.shutdownHost(session.id);
      const latest = store.get(session.id);
      if (!latest || !isAgentSessionBusy(latest)) return;
      await this.pauseTurn(
        scope,
        store,
        latest,
        activeTurnCorrelation(latest, latest.workerEpoch),
        'runtime',
        'Project closed before the Agent run settled.',
      );
    })));
  }

  assertProviderConfigurationChangeAllowed(): void {
    if (this.loaded?.store.list().some(isAgentSessionBusy)) {
      throw new Error('Stop all running Iris Agent Sessions before changing provider credentials.');
    }
  }

  async reloadProviderConfiguration(): Promise<void> {
    this.invalidateModelCatalog();
    const ids = [...this.hosts.keys()];
    await Promise.all(ids.map((id) => this.shutdownHost(id)));
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const terminal of this.terminals.values()) terminal.terminal.abort();
    for (const pending of this.pendingSupervisions.values()) {
      pending.reject(new Error('Iris Agent manager shut down during terminal supervision.'));
    }
    this.pendingSupervisions.clear();
    await Promise.allSettled([...this.hosts.values()].map((host) => host.shutdown('shutdown')));
    await Promise.allSettled([...this.sessionMutationChains.values()]);
    this.hosts.clear();
    this.terminals.clear();
    this.sessionMutationChains.clear();
    this.emittedProjections.clear();
    await this.loaded?.store.flush();
    this.loaded?.store.destroy();
    this.loaded = null;
  }

  private async preparePrompt(
    session: AgentSessionAggregate,
    userMessage: string,
    turnId = randomUUID(),
  ): Promise<PreparedAgentTurn> {
    const promptState = await this.projectManager.softwarePromptState();
    const anchorText = await this.readAnchorText(session.anchor);
    const assembled = assembleAgentPrompt({
      software: SOFTWARE_PROMPT_TEMPLATE,
      project: promptState.project.text,
      anchor: 'path' in anchorText
        ? { path: anchorText.path, text: anchorText.text }
        : { workspacePath: anchorText.workspacePath, text: anchorText.text },
    });
    const prompt = assembled.text + '\n\n<user-request>\n' + userMessage + '\n</user-request>';
    return {
      prompt,
      turnId,
      facts: {
        id: randomUUID(),
        turnId,
        createdAt: Date.now(),
        promptFingerprint: assembled.fingerprint,
        layerFingerprints: assembled.layerFingerprints,
        anchor: { ...session.anchor },
        promptChars: prompt.length,
        redacted: true,
      },
    };
  }

  private async readAnchorText(anchor: IrisAgentAnchor): Promise<
    { path: string; text: string } | { workspacePath: string; text: string }
  > {
    if (anchor.kind === 'document') {
      try {
        const doc = await this.projectManager.readDoc(anchor.path);
        return { path: doc.path, text: doc.raw };
      } catch (error) {
        throw new Error('anchor-missing: ' + errorMessage(error));
      }
    }
    return {
      workspacePath: anchor.path,
      text: 'Workspace anchor: ' + anchor.path + '\nFOCUS_DOC is unset. Read files explicitly before editing.',
    };
  }

  private async hostFor(
    session: AgentSessionAggregate,
    store: IrisAgentSessionStore,
    scope: ProjectScope,
  ): Promise<AgentWorkerHost> {
    const existing = this.hosts.get(session.id);
    if (existing) return existing;
    if (!session.model) throw new Error('Iris Agent Session has no configured model.');
    const next = cloneAgentSession(session);
    next.workerEpoch += 1;
    const withEpoch = await store.commit(next);
    this.emitChanged(scope, withEpoch);
    const host = new AgentWorkerHost(session.id, {
      loadHistory: async (sessionId) => store.history(sessionId),
      loadRuntime: async (sessionId) => {
        const latest = store.get(sessionId);
        if (!latest?.model) throw new Error('Iris Agent Session has no configured model.');
        const agentDir = irisPiAgentDir();
        const providerProfileRoot = this.options.providerProfileRoot ?? this.userDataPath;
        const providerProxy = this.options.resolveProxy
          ? parseElectronProxyRules(await this.options.resolveProxy(
              await resolveIrisModelBaseUrl(agentDir, providerProfileRoot, latest.model),
            ))
          : { mode: 'direct' as const };
        return {
          cwd: latest.projectRoot,
          agentDir,
          providerProfileRoot,
          model: { ...latest.model },
          commandShell: { ...this.commandShell },
          providerProxy,
        };
      },
      workerEpoch: withEpoch.workerEpoch,
      ...(this.options.workerFactory ? { workerFactory: this.options.workerFactory } : {}),
      ...(this.options.workerIdleTimeoutMs === undefined ? {} : { idleTimeoutMs: this.options.workerIdleTimeoutMs }),
    });
    host.on('event', (event: AgentWorkerEvent) => {
      if (this.hosts.get(session.id) === host) this.enqueueWorkerEvent(event);
    });
    host.on('workerError', (error: Error) => {
      if (this.hosts.get(session.id) === host) {
        this.rejectPendingSupervisions(
          session.id,
          host.workerEpoch,
          'Iris Agent Worker failed during terminal supervision.',
        );
        void this.enqueueSessionMutation(session.id, () =>
          this.pauseSessionExecution(session.id, error.message, undefined, 'worker'));
      }
    });
    host.on('crash', (code: number) => {
      if (this.hosts.get(session.id) === host) {
        this.rejectPendingSupervisions(
          session.id,
          host.workerEpoch,
          'Iris Agent Worker crashed during terminal supervision.',
        );
        void this.enqueueSessionMutation(session.id, () => this.pauseSessionExecution(
          session.id, 'Iris Agent Worker crashed with code ' + String(code), undefined, 'worker'));
      }
    });
    this.hosts.set(session.id, host);
    return host;
  }

  private enqueueWorkerEvent(event: AgentWorkerEvent): void {
    const sessionId = event.correlation.sessionId;
    void this.enqueueSessionMutation(sessionId, async () => {
      try {
        await this.handleWorkerEvent(event);
        if (event.eventId) {
          await this.hosts.get(sessionId)?.post({
            type: 'event-ack',
            correlation: event.correlation,
            eventId: event.eventId,
            ok: true,
          });
        }
      } catch (error) {
        if (event.eventId) {
          await this.hosts.get(sessionId)?.post({
            type: 'event-ack',
            correlation: event.correlation,
            eventId: event.eventId,
            ok: false,
            error: errorMessage(error),
          }).catch(() => undefined);
        }
        await this.pauseSessionExecution(sessionId, errorMessage(error), event.correlation, 'runtime');
      }
    });
  }

  private async handleWorkerEvent(event: AgentWorkerEvent): Promise<void> {
    const scope = this.currentScope;
    if (!scope) return;
    const store = await this.ensureStore(scope.root);
    const session = store.get(event.correlation.sessionId);
    if (!session || event.correlation.workerEpoch !== session.workerEpoch) return;
    switch (event.type) {
      case 'state':
        await this.applyRuntimeState(scope, store, session, event.state, event.correlation);
        return;
      case 'failure':
        await this.pauseSessionExecution(session.id, event.message, event.correlation, 'runtime');
        return;
      case 'ready':
        if (!session.currentTurnId) await this.commitAndEmit(scope, store, { ...session, state: 'ready' });
        return;
      case 'assistant-text-delta':
        await this.applyAssistantTextDelta(scope, store, session, event.delta, event.correlation);
        return;
      case 'provider-message':
        await this.applyProviderMessageEvent(scope, store, session, event.message, event.correlation);
        return;
      case 'provider-context':
        await this.persistProviderContext(scope, store, session, event).catch(() => undefined);
        return;
      case 'provider-attempt':
        await this.applyProviderAttemptEvent(scope, store, session, event);
        return;
      case 'terminal-supervision-result': {
        const pending = this.pendingSupervisions.get(event.supervisionId);
        if (pending) {
          this.pendingSupervisions.delete(event.supervisionId);
          pending.resolve(event.result);
        }
        return;
      }
      case 'execution-paused':
        await this.pauseSessionExecution(
          session.id,
          event.message,
          event.correlation,
          mapPauseReason(event.reason),
        );
        return;
      case 'execution-settled':
        await this.completeRun(scope, store, session, event.correlation);
        return;
      case 'tool-request':
        await this.handleToolRequest(scope, store, session, event);
        return;
      case 'stopped':
        return;
    }
  }

  private async persistProviderContext(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: AgentSessionAggregate,
    event: Extract<AgentWorkerEvent, { type: 'provider-context' }>,
  ): Promise<void> {
    const { turnId, providerCallId } = event.correlation;
    if (!turnId || !providerCallId || !matchesActiveAgentTurn(session, event.correlation)) return;
    const turn = session.turns.find((candidate) => candidate.id === turnId);
    await store.appendProviderContext(
      session.id,
      turnId,
      event.call,
      turn?.assembledInputAvailable === true,
      {
        appVersion: this.options.appVersion ?? 'unknown',
        protocolVersion: event.version,
        sessionRevision: session.revision,
        workerEpoch: session.workerEpoch,
      },
    );
    const latest = store.get(session.id) ?? session;
    const call = latest.providerCalls.find((candidate) => candidate.id === providerCallId);
    if (call) call.index = event.call.index;
    await this.commitAndEmit(scope, store, latest);
  }

  private async handleToolRequest(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: AgentSessionAggregate,
    event: Extract<AgentWorkerEvent, { type: 'tool-request' }>,
  ): Promise<void> {
    const correlation = event.correlation;
    if (!correlation.turnId || !correlation.toolCallId || !correlation.operationId) return;
    let current = store.get(session.id) ?? session;
    if (!matchesActiveAgentTurn(current, correlation)) return;
    const providerCallId = providerCallForToolCall(current, correlation.toolCallId);
    if (!providerCallId) {
      throw new Error('Tool Call does not belong to a committed assistant Provider message.');
    }
    const previousOperation = current.toolOperations.find(
      (operation) => operation.id === correlation.operationId,
    );
    if (previousOperation?.state === 'completed' && previousOperation.result) {
      await this.hosts.get(session.id)?.post({
        type: 'tool-result', correlation, ok: true, result: previousOperation.result,
      });
      return;
    }
    if (previousOperation?.state === 'failed') {
      await this.hosts.get(session.id)?.post({
        type: 'tool-result', correlation, ok: false,
        error: previousOperation.error ?? 'Iris Agent tool failed',
      });
      return;
    }
    if (previousOperation) return;
    let activity = current.timeline.find(
      (candidate): candidate is AgentToolActivity =>
        candidate.kind === 'tool' && candidate.toolCallId === correlation.toolCallId,
    );
    if (activity && activity.state !== 'running') {
      await this.hosts.get(session.id)?.post({
        type: 'tool-result', correlation, ok: false,
        error: 'Iris Agent received a new operation for a settled tool activity.',
      });
      return;
    }
    if (!activity) {
      activity = {
        kind: 'tool',
        id: correlation.toolCallId,
        ordinal: current.nextOrdinal++,
        turnId: correlation.turnId,
        providerCallId,
        toolCallId: correlation.toolCallId,
        tool: event.input.tool,
        ...(event.input.tool === 'terminal' ? { intent: event.input.intent } : {}),
        state: 'running',
        inputSummary: compactToolInput(event.input),
        operation: event.input.operation,
        ...(event.input.tool === 'terminal'
          ? {
              command: event.input.command,
              cwd: event.input.cwd,
              terminalSuccessExitCodes: event.input.successExitCodes ?? [0],
            }
          : {}),
        effectIds: [],
        createdAt: Date.now(),
      };
      current.timeline.push(activity);
    }
    current.toolOperations.push({
      id: correlation.operationId,
      toolActivityId: activity.id,
      turnId: correlation.turnId,
      input: structuredClone(event.input),
      state: 'running',
      createdAt: Date.now(),
    });
    current.state = 'waiting-tool';
    current = await this.commitAndEmit(scope, store, current);
    const operationCorrelation = {
      sessionId: session.id,
      turnId: correlation.turnId,
      toolCallId: correlation.toolCallId,
      operationId: correlation.operationId,
    };
    const execution = this.options.toolExecutor
      ? this.options.toolExecutor(event.input, operationCorrelation)
      : new IrisAgentToolHost({
          projectRoot: scope.root,
          artifactRoot: store.artifactRoot(session.id),
          commandShell: this.commandShell,
          displayThresholdMs: this.options.terminalDisplayThresholdMs ?? 3_000,
          ...(this.options.terminalFactory
            ? { terminalFactory: this.options.terminalFactory }
            : {}),
          onTerminalCreated: (terminal, context) => {
            this.terminals.set(context.terminalId, {
              sessionId: session.id,
              terminal,
              outputPath: context.outputPath,
              cursor: 0,
              plainText: '',
              running: true,
            });
            void this.enqueueSessionMutation(session.id, () => this.recordTerminalStarted(
              scope,
              store,
              session.id,
              context.terminalId,
              context.correlation,
            ));
            this.scheduleTerminalSupervision(session.id, context.terminalId);
          },
          onTerminalEvent: (terminalEvent, context) => {
            this.handleTerminalEvent(scope, store, session.id, terminalEvent, context.correlation);
          },
        }).execute(event.input, operationCorrelation);
    void execution.then((executed) => this.enqueueSessionMutation(session.id, () => this.settleToolOperation(
      scope,
      store,
      session.id,
      activity.id,
      event,
      executed,
    ))).catch((error) => this.enqueueSessionMutation(session.id, () =>
      this.pauseSessionExecution(session.id, errorMessage(error), correlation, 'runtime')));
  }

  private async settleToolOperation(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    sessionId: string,
    activityId: string,
    event: Extract<AgentWorkerEvent, { type: 'tool-request' }>,
    executed: IrisAgentToolHostResult,
  ): Promise<void> {
    const correlation = event.correlation;
    const terminalExecution = executed.result.kind === 'terminal' ? executed.result : null;
    if (terminalExecution) this.releaseTerminal(terminalExecution.terminalId);
    const latest = store.get(sessionId);
    if (!latest) return;
    const target = latest.timeline.find(
      (candidate): candidate is AgentToolActivity => candidate.kind === 'tool' && candidate.id === activityId,
    );
    if (!target) return;
    const operation = latest.toolOperations.find((candidate) => candidate.id === correlation.operationId);
    if (!operation) return;
    if (operation.state !== 'running') {
      const lateTerminalResult = terminalExecution !== null && target.tool === 'terminal';
      if (lateTerminalResult) {
        target.terminalId = terminalExecution.terminalId;
        target.terminalState = 'exited';
        if (target.state === 'canceled') target.terminalOutcome = 'canceled';
        else if (executed.update.terminalOutcome) {
          target.terminalOutcome = executed.update.terminalOutcome;
        }
        target.terminalCompletedAt = executed.update.terminalCompletedAt ?? executed.update.completedAt;
        if (executed.update.terminalExitCode !== undefined) {
          target.terminalExitCode = executed.update.terminalExitCode;
        }
        if (executed.update.terminalSuccessExitCodes !== undefined) {
          target.terminalSuccessExitCodes = executed.update.terminalSuccessExitCodes;
        }
        if (executed.update.terminalOutputBytes !== undefined) {
          target.terminalOutputBytes = executed.update.terminalOutputBytes;
        }
        if (executed.update.terminalOutputPreview !== undefined) {
          target.terminalOutputPreview = executed.update.terminalOutputPreview;
        }
      }
      const lateEffects = executed.effects.filter(
        (effect) => !latest.effects.some((candidate) => candidate.id === effect.id),
      );
      if (lateEffects.length === 0 && !lateTerminalResult) return;
      latest.effects.push(...lateEffects);
      await this.commitAndEmit(scope, store, latest);
      return;
    }
    const terminalResult = terminalExecution !== null;
    operation.state = executed.update.state === 'failed' && !terminalResult ? 'failed' : 'completed';
    operation.completedAt = executed.update.completedAt;
    if (operation.state === 'failed') {
      operation.error = executed.update.error ?? 'Iris Agent tool failed';
    }
    else operation.result = structuredClone(executed.result);
    const { state: _state, completedAt: _completedAt, ...activityUpdate } = executed.update;
    if (target.state === 'running') {
      Object.assign(target, activityUpdate);
      if (executed.update.state === 'failed') {
        target.state = 'failed';
        target.completedAt = executed.update.completedAt;
      }
    }
    const newEffects = executed.effects.filter(
      (effect) => !latest.effects.some((candidate) => candidate.id === effect.id),
    );
    if (target.state === 'running') target.effectIds.push(...newEffects.map((effect) => effect.id));
    latest.effects.push(...newEffects);
    if (terminalResult && latest.terminalSupervisionAlert?.terminalId === target.terminalId) {
      delete latest.terminalSupervisionAlert;
    }
    if (latest.state === 'waiting-tool' && matchesActiveAgentTurn(latest, correlation)) latest.state = 'running';
    await this.commitAndEmit(scope, store, latest);
    const settled = store.get(sessionId) ?? latest;
    if (currentAgentTurn(settled)?.state !== 'running' || !matchesActiveAgentTurn(settled, correlation)) return;
    await this.hosts.get(sessionId)?.post(
      executed.update.state === 'failed' && !terminalResult
        ? {
            type: 'tool-result',
            correlation,
            ok: false,
            error: executed.update.error ?? 'Iris Agent tool failed',
          }
        : { type: 'tool-result', correlation, ok: true, result: executed.result },
    );
  }

  private async recordTerminalStarted(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    sessionId: string,
    terminalId: string,
    correlation: AgentCorrelation,
  ): Promise<void> {
    const session = store.get(sessionId);
    if (!session || !correlation.toolCallId) return;
    const activity = session.timeline.find(
      (candidate): candidate is AgentToolActivity =>
        candidate.kind === 'tool' && candidate.toolCallId === correlation.toolCallId,
    );
    if (!activity || activity.terminalId) return;
    activity.terminalId = terminalId;
    activity.terminalArtifactRef = `terminal/${terminalId}.log`;
    activity.terminalState = 'running';
    activity.terminalStartedAt = Date.now();
    await this.commitAndEmit(scope, store, session);
  }

  private handleTerminalEvent(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    sessionId: string,
    event: AgentCommandPtyEvent,
    correlation: AgentCorrelation,
  ): void {
    if (event.type === 'output' && event.cursor !== undefined && event.data) {
      this.emit('terminalOutput', {
        sessionId,
        terminalId: event.terminalId,
        cursor: event.cursor,
        data: event.data,
      } satisfies IrisAgentTerminalOutputPayload);
      return;
    }
    if (event.type === 'completed') {
      const terminal = this.terminals.get(event.terminalId);
      if (terminal) {
        terminal.running = false;
        if (terminal.timer) clearTimeout(terminal.timer);
        delete terminal.timer;
      }
      return;
    }
    if (event.type !== 'shown') return;
    void this.enqueueSessionMutation(sessionId, async () => {
      const session = store.get(sessionId);
      if (!session || !correlation.toolCallId) return;
      const activity = session.timeline.find(
        (candidate): candidate is AgentToolActivity =>
          candidate.kind === 'tool' && candidate.toolCallId === correlation.toolCallId,
      );
      if (!activity || activity.terminalRevealedAt) return;
      activity.terminalId = event.terminalId;
      activity.terminalArtifactRef ??= `terminal/${event.terminalId}.log`;
      activity.terminalState = 'running';
      activity.terminalStartedAt ??= Date.now();
      activity.terminalRevealedAt = Date.now();
      await this.commitAndEmit(scope, store, session);
    });
  }

  private scheduleTerminalSupervision(sessionId: string, terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.sessionId !== sessionId || !terminal.running || terminal.timer) return;
    terminal.timer = setTimeout(() => {
      delete terminal.timer;
      void this.runTerminalSupervision(sessionId, terminalId).catch(() => {
        this.scheduleTerminalSupervision(sessionId, terminalId);
      });
    }, this.options.supervisionIntervalMs ?? 20_000);
  }

  private async runTerminalSupervision(sessionId: string, terminalId: string): Promise<void> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.sessionId !== sessionId || !terminal.running) return;
    const observation = await terminal.terminal.observation();
    if (!observation.running) return;
    if (observation.cursor <= terminal.cursor) {
      this.scheduleTerminalSupervision(sessionId, terminalId);
      return;
    }
    const cursorStart = terminal.cursor;
    const overlapOutput = terminal.plainText.slice(-2_000);
    const incrementalOutput = observation.text.startsWith(terminal.plainText)
      ? observation.text.slice(terminal.plainText.length)
      : observation.text.slice(-32_000);
    terminal.cursor = observation.cursor;
    terminal.plainText = observation.text;
    if (!incrementalOutput.trim()) {
      this.scheduleTerminalSupervision(sessionId, terminalId);
      return;
    }
    const scope = this.currentScope;
    const store = this.loaded?.store;
    const session = store?.get(sessionId);
    const activity = session ? terminalActivity(session, terminalId) : undefined;
    if (!scope || !store || !session || !activity || activity.state !== 'running') return;
    const input: AgentTerminalSupervisionInput = {
      terminalId,
      command: activity.command ?? activity.inputSummary,
      cursorStart,
      cursorEnd: observation.cursor,
      overlapOutput,
      incrementalOutput: incrementalOutput.slice(-32_000),
      processState: 'running',
    };
    let result: AgentTerminalSupervisionResult;
    try {
      result = await this.requestTerminalSupervision(sessionId, input);
    } catch {
      this.scheduleTerminalSupervision(sessionId, terminalId);
      return;
    }
    if (!terminal.running) return;
    this.supervisionLog.record({
      terminalId,
      cursorStart,
      cursorEnd: observation.cursor,
      outcome: result.outcome,
      ...(result.usageTokens === undefined ? {} : { usageTokens: result.usageTokens }),
    });
    if (result.outcome !== 'suspicious') {
      this.scheduleTerminalSupervision(sessionId, terminalId);
      return;
    }
    await this.enqueueSessionMutation(sessionId, async () => {
      const latest = store.get(sessionId);
      if (
        !terminal.running || !latest ||
        terminalActivity(latest, terminalId)?.state !== 'running'
      ) return;
      latest.terminalSupervisionAlert = {
        terminalId,
        evidence: result.evidence ?? 'The terminal supervisor detected suspicious output.',
        createdAt: Date.now(),
      };
      await this.commitAndEmit(scope, store, latest);
    });
  }

  private async requestTerminalSupervision(
    sessionId: string,
    input: AgentTerminalSupervisionInput,
  ): Promise<AgentTerminalSupervisionResult> {
    const host = this.hosts.get(sessionId);
    if (!host) throw new Error('Iris Agent Worker is unavailable for terminal supervision.');
    const supervisionId = randomUUID();
    const result = new Promise<AgentTerminalSupervisionResult>((resolve, reject) => {
      this.pendingSupervisions.set(supervisionId, {
        sessionId,
        workerEpoch: host.workerEpoch,
        resolve,
        reject,
      });
    });
    try {
      await host.post({
        type: 'supervise-terminal',
        correlation: { sessionId, workerEpoch: host.workerEpoch },
        supervisionId,
        input,
      });
    } catch (error) {
      this.pendingSupervisions.delete(supervisionId);
      throw error;
    }
    return result;
  }

  private async applyAssistantTextDelta(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: AgentSessionAggregate,
    delta: string,
    correlation: AgentWorkerEvent['correlation'],
  ): Promise<void> {
    const latest = store.get(session.id) ?? session;
    if (!matchesActiveAgentTurn(latest, correlation) || !delta) return;
    const reply = ensureReply(latest, correlation, Date.now());
    if (!reply || reply.state !== 'streaming') return;
    reply.content += delta;
    await this.commitAndEmit(scope, store, latest);
  }

  private async applyProviderMessageEvent(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: AgentSessionAggregate,
    message: Record<string, unknown>,
    correlation: AgentWorkerEvent['correlation'],
  ): Promise<void> {
    const latest = store.get(session.id) ?? session;
    if (!matchesActiveAgentTurn(latest, correlation)) return;
    applyProviderMessage(latest, message, correlation);
    await this.commitAndEmit(scope, store, latest);
  }

  private async applyProviderAttemptEvent(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: AgentSessionAggregate,
    event: Extract<AgentWorkerEvent, { type: 'provider-attempt' }>,
  ): Promise<void> {
    const { turnId, providerCallId, attemptId } = event.correlation;
    if (!turnId || !providerCallId || !attemptId) return;
    const latest = store.get(session.id) ?? session;
    if (!matchesActiveAgentTurn(latest, event.correlation)) return;
    const now = Date.now();
    let call = latest.providerCalls.find((candidate) => candidate.id === providerCallId);
    if (event.phase === 'started' && !call) {
      call = {
        id: providerCallId,
        turnId,
        index: latest.providerCalls.length + 1,
        state: 'running',
        attemptIds: [],
        createdAt: now,
      };
      latest.providerCalls.push(call);
    }
    if (!call) return;
    let attempt = latest.providerAttempts.find((candidate) => candidate.id === attemptId);
    if (event.phase === 'started' && !attempt) {
      attempt = {
        id: attemptId,
        providerCallId,
        turnId,
        index: event.index,
        state: 'running',
        createdAt: now,
      };
      latest.providerAttempts.push(attempt);
      call.attemptIds.push(attemptId);
    }
    if (!attempt) return;
    if (event.phase !== 'started') {
      attempt.state = event.phase;
      attempt.completedAt = now;
      if (event.error) attempt.error = event.error;
      if (event.phase === 'completed') {
        call.state = 'completed';
        call.completedAt = now;
      }
      if (event.phase === 'failed' || event.phase === 'aborted') {
        const reply = latest.timeline.find(
          (candidate): candidate is AgentReplyActivity =>
            candidate.kind === 'reply' && candidate.providerAttemptId === attemptId &&
            candidate.state === 'streaming',
        );
        if (reply) {
          reply.state = event.phase === 'aborted' ? 'stopped' : 'failed';
          reply.contextDisposition = 'excluded';
          reply.completedAt = now;
          if (event.error) reply.error = event.error;
        }
      }
    }
    await this.commitAndEmit(scope, store, latest);
  }

  private async applyRuntimeState(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: AgentSessionAggregate,
    state: AgentSessionRuntimeState,
    correlation: AgentWorkerEvent['correlation'],
  ): Promise<void> {
    if (state === 'interrupted') {
      await this.pauseSessionExecution(session.id, 'Paused by user.', correlation, 'user');
      return;
    }
    if (session.currentTurnId && !matchesActiveAgentTurn(session, correlation)) return;
    if (state === 'idle' && session.currentTurnId) return;
    const mapped = mapRuntimeState(state);
    if (!mapped || mapped === session.state) return;
    session.state = mapped;
    await this.commitAndEmit(scope, store, session);
  }

  private async completeRun(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: AgentSessionAggregate,
    correlation: AgentWorkerEvent['correlation'],
  ): Promise<AgentSessionAggregate> {
    const latest = store.get(session.id) ?? session;
    const completed = completeActiveAgentTurn(latest, correlation);
    if (completed === latest) return latest;
    const saved = await this.commitAndEmit(scope, store, completed);
    this.hosts.get(session.id)?.markIdle();
    return saved;
  }

  private async pauseTurn(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: AgentSessionAggregate,
    correlation: AgentWorkerEvent['correlation'],
    reason: IrisAgentPauseReason,
    message: string,
  ): Promise<AgentSessionAggregate> {
    const latest = store.get(session.id) ?? session;
    const paused = pauseActiveAgentTurn(latest, correlation, reason, message);
    if (paused === latest) return latest;
    const saved = await this.commitAndEmit(scope, store, paused);
    this.hosts.get(session.id)?.markIdle();
    return saved;
  }

  private async pauseSessionExecution(
    sessionId: string,
    message: string,
    correlation?: AgentWorkerEvent['correlation'],
    reason: IrisAgentPauseReason = 'runtime',
  ): Promise<void> {
    const scope = this.currentScope;
    if (!scope) return;
    const store = await this.ensureStore(scope.root);
    const session = store.get(sessionId);
    if (!session?.currentTurnId) return;
    this.abortSessionTerminals(sessionId);
    await this.shutdownHost(sessionId);
    const latest = store.get(sessionId) ?? session;
    if (currentAgentTurn(latest)?.state === 'paused') return;
    await this.pauseTurn(
      scope,
      store,
      latest,
      correlation ?? activeTurnCorrelation(latest, latest.workerEpoch),
      reason,
      message,
    );
  }

  private async commitAndEmit(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: AgentSessionAggregate,
  ): Promise<AgentSessionAggregate> {
    const saved = await store.commit(session);
    this.emitChanged(scope, saved);
    return saved;
  }

  private async requireSession(scope: ProjectScope, sessionId: string): Promise<AgentSessionAggregate> {
    const store = await this.ensureStore(scope.root);
    const session = store.get(sessionId);
    if (!session || session.projectRoot !== scope.root) {
      throw new Error('Iris Agent session is outside the active project scope.');
    }
    return session;
  }

  private assertUsableModel(session: AgentSessionAggregate): void {
    if (!session.model) throw new Error('Select an available provider/model before using Iris Agent.');
  }

  private async verifyAnchor(anchor: IrisAgentAnchor): Promise<void> {
    if (anchor.kind === 'document') await this.projectManager.readDoc(anchor.path);
  }

  private async loadModelCatalog(forceRefresh = false): Promise<IrisAgentModelCatalog> {
    if (
      forceRefresh &&
      this.modelCatalogLoad?.generation !== this.modelCatalogGeneration
    ) {
      this.invalidateModelCatalog();
    }
    if (this.modelCatalogCache) return structuredClone(this.modelCatalogCache);
    const generation = this.modelCatalogGeneration;
    if (this.modelCatalogLoad?.generation === generation) {
      return structuredClone(await this.modelCatalogLoad.promise);
    }
    const promise = (this.options.modelCatalogLoader?.() ?? loadIrisModelCatalog(
      irisPiAgentDir(),
      this.options.providerProfileRoot ?? this.userDataPath,
    )).then((catalog) => {
      if (this.modelCatalogGeneration === generation) {
        this.modelCatalogCache = structuredClone(catalog);
      }
      return catalog;
    });
    this.modelCatalogLoad = { generation, promise };
    try {
      return structuredClone(await promise);
    } finally {
      if (this.modelCatalogLoad?.promise === promise) this.modelCatalogLoad = null;
    }
  }

  private invalidateModelCatalog(): void {
    this.modelCatalogGeneration += 1;
    this.modelCatalogCache = null;
  }

  private async ensureStore(projectRoot: string): Promise<IrisAgentSessionStore> {
    if (this.loaded?.root === projectRoot) return this.loaded.store;
    await this.loaded?.store.flush();
    this.loaded?.store.destroy();
    const store = await IrisAgentSessionStore.load({ userDataPath: this.userDataPath, projectRoot });
    this.loaded = { root: projectRoot, store };
    return store;
  }

  private async shutdownHost(sessionId: string): Promise<void> {
    const host = this.hosts.get(sessionId);
    if (host) this.hosts.delete(sessionId);
    if (host) {
      this.rejectPendingSupervisions(
        sessionId,
        host.workerEpoch,
        'Iris Agent Worker stopped during terminal supervision.',
      );
    }
    await host?.shutdown('shutdown');
  }

  private rejectPendingSupervisions(
    sessionId: string,
    workerEpoch: number,
    message: string,
  ): void {
    for (const [supervisionId, pending] of this.pendingSupervisions) {
      if (pending.sessionId !== sessionId || pending.workerEpoch !== workerEpoch) continue;
      this.pendingSupervisions.delete(supervisionId);
      pending.reject(new Error(message));
    }
  }

  private abortSessionTerminals(sessionId: string): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.sessionId !== sessionId) continue;
      if (terminal.timer) clearTimeout(terminal.timer);
      terminal.running = false;
      terminal.terminal.abort();
    }
  }

  private releaseTerminal(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.running) return;
    if (terminal.timer) clearTimeout(terminal.timer);
    terminal.terminal.dispose();
    this.terminals.delete(terminalId);
  }

  private runSessionCommand<T>(sessionId: string, command: () => Promise<T>): Promise<T> {
    return this.enqueueSessionMutation(sessionId, () => {
      if (this.shuttingDown) throw new Error('Iris Agent manager is shutting down.');
      return command();
    });
  }

  private enqueueSessionMutation<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutationChains.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(mutation);
    const tail = result.then(() => undefined, () => undefined);
    this.sessionMutationChains.set(sessionId, tail);
    void tail.finally(() => {
      if (this.sessionMutationChains.get(sessionId) === tail) this.sessionMutationChains.delete(sessionId);
    });
    return result;
  }

  private emitChanged(scope: ProjectScope, session: AgentSessionAggregate): void {
    const projected = projectAgentSession(session, scope.generation);
    const previous = this.emittedProjections.get(session.id) ?? null;
    const update = diffAgentSessionProjection(previous, projected);
    this.emittedProjections.set(session.id, structuredClone(projected));
    this.emit('sessionChanged', {
      scope,
      update,
    } satisfies IrisAgentSessionChangedPayload);
  }
}

export function createIrisAgentBranch(
  source: AgentSessionAggregate,
  throughTurnId: string,
  id: string,
  displayName: string,
  now: number,
): AgentSessionAggregate {
  assertQuiescentIrisAgentSession(source);
  const index = source.turns.findIndex((turn) => turn.id === throughTurnId);
  if (index < 0) throw new Error('The Iris Agent branch point was not found.');
  if (source.turns[index]!.state !== 'fulfilled') {
    throw new Error('Cannot branch from an incomplete Iris Agent turn.');
  }
  const branch = createEmptyAgentSession({
    id,
    anchor: source.anchor,
    model: source.model,
    projectRoot: source.projectRoot,
    displayName,
    now,
  });
  branch.parentSessionId = source.id;
  branch.forkedFromTurnId = throughTurnId;
  branch.turns = structuredClone(source.turns.slice(0, index + 1)).map((turn) => ({
    ...turn,
    assembledInputAvailable: false,
  }));
  const turnIds = new Set(branch.turns.map((turn) => turn.id));
  branch.providerCalls = structuredClone(source.providerCalls.filter((call) => turnIds.has(call.turnId)));
  branch.providerAttempts = structuredClone(source.providerAttempts.filter((attempt) => turnIds.has(attempt.turnId)));
  branch.timeline = structuredClone(source.timeline.filter((activity) => turnIds.has(activity.turnId)));
  branch.transcript = structuredClone(source.transcript.filter((frame) => turnIds.has(frame.turnId)));
  branch.nextOrdinal = Math.max(0, ...branch.timeline.map((activity) => activity.ordinal)) + 1;
  return branch;
}

export function parseElectronProxyRules(rules: string): AgentProviderProxy {
  const entries = rules.split(';').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return { mode: 'direct' };
  let sawUnsupportedProxy = false;
  for (const entry of entries) {
    if (/^DIRECT$/iu.test(entry)) return { mode: 'direct' };
    const match = entry.match(/^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(.+)$/iu);
    if (!match) continue;
    const kind = match[1]!.toUpperCase();
    if (kind.startsWith('SOCKS')) {
      sawUnsupportedProxy = true;
      continue;
    }
    const protocol = kind === 'HTTPS' ? 'https:' : 'http:';
    const url = new URL(`${protocol}//${match[2]!.trim()}`);
    if (!url.hostname || !url.port) throw new Error('Windows returned an invalid system proxy endpoint.');
    return { mode: 'proxy', url: url.href };
  }
  if (sawUnsupportedProxy) {
    throw new Error('The Windows system proxy resolved only to SOCKS, which this provider transport does not support.');
  }
  throw new Error('Windows returned an unsupported system proxy rule.');
}

export function applyIrisAgentMessageRewind(session: AgentSessionAggregate): AgentSessionAggregate {
  return undoLatestIrisAgentTurn(session);
}

export function completeIrisAgentTurn(
  session: AgentSessionAggregate,
  correlation: AgentWorkerEvent['correlation'],
): AgentSessionAggregate {
  return completeActiveAgentTurn(session, correlation);
}

export function pauseIrisAgentTurn(
  session: AgentSessionAggregate,
  correlation: AgentWorkerEvent['correlation'],
  reason: IrisAgentPauseReason,
  message: string,
): AgentSessionAggregate {
  return pauseActiveAgentTurn(session, correlation, reason, message);
}

function activeTurnCorrelation(session: AgentSessionAggregate, workerEpoch: number) {
  if (!session.currentTurnId) throw new Error('Iris Agent session has no active Turn.');
  return {
    sessionId: session.id,
    workerEpoch,
    turnId: session.currentTurnId,
  };
}

function ensureReply(
  session: AgentSessionAggregate,
  correlation: AgentWorkerEvent['correlation'],
  now: number,
): AgentReplyActivity | null {
  const { turnId, providerCallId, attemptId, providerMessageId } = correlation;
  if (!turnId || !providerCallId || !attemptId || !providerMessageId) return null;
  const existing = session.timeline.find(
    (activity): activity is AgentReplyActivity =>
      activity.kind === 'reply' && activity.providerMessageId === providerMessageId,
  );
  if (existing) return existing;
  const reply: AgentReplyActivity = {
    kind: 'reply',
    id: `reply:${providerMessageId}`,
    ordinal: session.nextOrdinal++,
    turnId,
    providerCallId,
    providerAttemptId: attemptId,
    providerMessageId,
    state: 'streaming',
    contextDisposition: 'pending',
    content: '',
    createdAt: now,
  };
  session.timeline.push(reply);
  return reply;
}

function applyProviderMessage(
  session: AgentSessionAggregate,
  message: Record<string, unknown>,
  correlation: AgentWorkerEvent['correlation'],
): void {
  const { turnId } = correlation;
  if (!turnId) return;
  const role = message.role;
  const content = providerMessageText(message) ?? '';
  const providerMessageId = correlation.providerMessageId ?? randomUUID();
  const stopReason = typeof message.stopReason === 'string' ? message.stopReason : '';
  if (role === 'assistant') {
    const failed = stopReason === 'error';
    const aborted = stopReason === 'aborted';
    if (!failed && !aborted && !session.transcript.some((frame) => frame.id === providerMessageId)) {
      if (correlation.providerCallId) {
        session.transcript.push({
          id: providerMessageId,
          turnId,
          role: 'assistant',
          providerCallId: correlation.providerCallId,
          content,
          providerMessage: structuredClone(message),
          createdAt: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
        });
      }
    }
    const reply = content.trim() !== '' ? ensureReply(session, { ...correlation, providerMessageId }, Date.now()) : null;
    if (reply) {
      reply.content = content;
      reply.state = failed ? 'failed' : aborted ? 'stopped' : 'completed';
      reply.contextDisposition = failed || aborted ? 'excluded' : 'committed';
      reply.completedAt = Date.now();
      if (failed && typeof message.errorMessage === 'string') reply.error = message.errorMessage;
    }
    return;
  }
  if (role !== 'toolResult') return;
  if (session.transcript.some((frame) => frame.id === providerMessageId)) return;
  const toolCallId = correlation.toolCallId ?? (typeof message.toolCallId === 'string' ? message.toolCallId : null);
  if (!toolCallId) return;
  session.transcript.push({
    id: providerMessageId,
    turnId,
    role: 'tool',
    toolCallId,
    content,
    providerMessage: structuredClone(message),
    createdAt: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
  });
  if (role === 'toolResult') {
    const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : null;
    const activity = toolCallId
      ? session.timeline.find(
          (candidate): candidate is AgentToolActivity =>
            candidate.kind === 'tool' && candidate.toolCallId === toolCallId,
        )
      : null;
    if (activity && activity.state === 'running') {
      activity.state = message.isError === true ? 'failed' : 'completed';
      activity.completedAt = typeof message.timestamp === 'number' ? message.timestamp : Date.now();
      if (message.isError === true && content) activity.error = content;
    }
  }
}

function providerCallForToolCall(session: AgentSessionAggregate, toolCallId: string): string | null {
  for (let index = session.transcript.length - 1; index >= 0; index -= 1) {
    const frame = session.transcript[index]!;
    if (frame.role !== 'assistant' || !Array.isArray(frame.providerMessage?.content)) continue;
    const ownsToolCall = frame.providerMessage.content.some(
      (block) => isRecord(block) && block.type === 'toolCall' && block.id === toolCallId,
    );
    if (ownsToolCall) return frame.providerCallId;
  }
  return null;
}

function providerMessageText(message: Record<string, unknown>): string | null {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return null;
  return message.content.flatMap((part) =>
    isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
}

function compactToolInput(input: AgentToolOperationInput): string {
  return input.tool === 'terminal'
    ? input.command.slice(0, 220)
    : (input.operation + ' ' + input.absolutePath).slice(0, 220);
}

function mapRuntimeState(state: AgentSessionRuntimeState): AgentSessionAggregate['state'] | null {
  if (state === 'interrupted') return null;
  return state;
}

function mapPauseReason(
  reason: Extract<AgentWorkerEvent, { type: 'execution-paused' }>['reason'],
): IrisAgentPauseReason {
  if (reason === 'auth-required') return 'auth';
  if (reason === 'provider-exhausted') return 'provider';
  if (reason === 'worker-crashed') return 'worker';
  return 'runtime';
}

function sameModel(left: IrisAgentModelRef | null, right: IrisAgentModelRef): boolean {
  return left?.provider === right.provider && left.modelId === right.modelId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminalActivity(
  session: AgentSessionAggregate,
  terminalId: string,
): AgentToolActivity | undefined {
  return session.timeline.find(
    (activity): activity is AgentToolActivity =>
      activity.kind === 'tool' && activity.tool === 'terminal' && activity.terminalId === terminalId,
  );
}

function terminalArtifactRef(
  session: AgentSessionAggregate,
  activity: AgentToolActivity,
): string | undefined {
  return activity.terminalArtifactRef ?? session.effects.find(
    (effect) => effect.kind === 'terminal-output' && effect.toolActivityId === activity.id,
  )?.artifactRef;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
