import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ProjectManager } from '../project-manager';
import { assembleAgentPrompt } from './prompt';
import { AgentWorkerHost } from './worker-host';
import { irisPiAgentDir } from './pi-adapter';
import { IrisAgentSessionStore } from './session-store';
import { IrisAgentToolHost } from './tool-host';
import type {
  AgentSessionRuntimeState,
  AgentToolOperationInput,
  AgentWorkerEvent,
} from '@shared/agent-protocol';
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

export class IrisAgentSessionManager extends EventEmitter {
  private loaded: LoadedStore | null = null;
  private readonly hosts = new Map<string, AgentWorkerHost>();
  private currentScope: ProjectScope | null = null;

  constructor(
    private readonly userDataPath: string,
    private readonly projectManager: ProjectManager,
  ) {
    super();
  }

  async list(scope: ProjectScope): Promise<IrisAgentListSnapshot> {
    this.currentScope = scope;
    const store = await this.ensureStore(scope.root);
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

  async send(scope: ProjectScope, sessionId: string, message: string): Promise<IrisAgentSessionInfo> {
    this.currentScope = scope;
    const store = await this.ensureStore(scope.root);
    const session = await this.requireSession(scope, sessionId);
    if (!isStoppedState(session.state)) {
      throw new Error('Iris Agent session is already running.');
    }
    const prepared = await this.preparePrompt(session, message);
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
    this.emitChanged(scope, running);
    const host = this.hostFor(running, store);
    await host.post({
      type: 'run',
      correlation: {
        sessionId,
        requestId: prepared.requestId,
        turnId: prepared.turnId,
      },
      prompt: prepared.prompt,
    });
    return running;
  }

  async stop(scope: ProjectScope, sessionId: string): Promise<IrisAgentSessionInfo> {
    this.currentScope = scope;
    const store = await this.ensureStore(scope.root);
    const session = await this.requireSession(scope, sessionId);
    const stopping = store.upsert({ ...session, state: 'stopping' });
    this.emitChanged(scope, stopping);
    await this.hosts.get(sessionId)?.post({
      type: 'abort',
      correlation: { sessionId },
      reason: 'user',
    });
    return stopping;
  }

  async retry(scope: ProjectScope, sessionId: string): Promise<IrisAgentSessionInfo> {
    const session = await this.requireSession(scope, sessionId);
    const retryTurn = [...session.turns].reverse().find(
      (turn) => turn.status === 'failed' || turn.status === 'stopped',
    );
    if (!retryTurn) throw new Error('No failed or stopped Iris Agent turn is available to retry.');
    const userMessage = session.messages.find((message) => message.id === retryTurn.userMessageId);
    if (!userMessage) throw new Error('Retry source message is missing.');
    return this.send(scope, sessionId, userMessage.content);
  }

  async rewind(scope: ProjectScope, sessionId: string, turnId: string): Promise<IrisAgentSessionInfo> {
    this.currentScope = scope;
    const store = await this.ensureStore(scope.root);
    const session = await this.requireSession(scope, sessionId);
    if (!isStoppedState(session.state)) {
      throw new Error('Stop the Iris Agent session before rewinding messages.');
    }
    const rewound = store.upsert(applyIrisAgentMessageRewind(session, turnId));
    this.emitChanged(scope, rewound);
    return rewound;
  }

  async closeSession(scope: ProjectScope, sessionId: string): Promise<void> {
    const store = await this.ensureStore(scope.root);
    await this.hosts.get(sessionId)?.shutdown();
    this.hosts.delete(sessionId);
    store.delete(sessionId);
    this.emit('sessionDestroyed', { scope, sessionId } satisfies IrisAgentSessionDestroyedPayload);
  }

  async closeProject(scope: ProjectScope): Promise<void> {
    const store = await this.ensureStore(scope.root);
    const sessions = store.list(scope);
    await Promise.allSettled(
      sessions.map(async (session) => {
        await this.hosts.get(session.id)?.shutdown('shutdown');
        this.hosts.delete(session.id);
      }),
    );
    await store.flush();
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.hosts.values()].map((host) => host.shutdown('shutdown')));
    this.hosts.clear();
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
    const host = new AgentWorkerHost(session.id, {
      loadHistory: async (sessionId) => store.history(sessionId),
      loadRuntime: async () => ({ cwd: session.projectRoot, agentDir: irisPiAgentDir() }),
    });
    host.on('event', (event: AgentWorkerEvent) => {
      void this.handleWorkerEvent(event).catch((err) => {
        this.markFailed(session.id, err instanceof Error ? err.message : String(err));
      });
    });
    host.on('workerError', (err: Error) => void this.markFailed(session.id, err.message));
    host.on('crash', (code: number) => void this.markFailed(session.id, 'Iris Agent Worker crashed with code ' + String(code)));
    this.hosts.set(session.id, host);
    return host;
  }

  private async handleWorkerEvent(event: AgentWorkerEvent): Promise<void> {
    const scope = this.currentScope;
    if (!scope) return;
    const store = await this.ensureStore(scope.root);
    const session = store.get(event.correlation.sessionId);
    if (!session) return;
    if (event.type === 'state') {
      this.updateRuntimeState(scope, store, session, event.state);
      return;
    }
    if (event.type === 'failure') {
      this.markFailed(session.id, event.message);
      return;
    }
    if (event.type === 'ready') {
      this.emitChanged(scope, store.upsert({ ...session, state: 'ready' }));
      return;
    }
    if (event.type === 'stream') {
      this.applyStreamEvent(scope, store, session, event.event);
      return;
    }
    if (event.type === 'tool-request') {
      await this.handleToolRequest(scope, store, session, event);
      return;
    }
    if (event.type === 'stopped') {
      this.updateRuntimeState(scope, store, session, 'idle');
    }
  }

  private async handleToolRequest(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: IrisAgentSessionInfo,
    event: Extract<AgentWorkerEvent, { type: 'tool-request' }>,
  ): Promise<void> {
    const correlation = event.correlation;
    if (!correlation.requestId || !correlation.turnId || !correlation.toolCallId) return;
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
      state: executed.event.state === 'failed' ? 'running' : latest.state,
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
  ): void {
    const delta = textDelta(event);
    if (delta) {
      const updated = this.updateAssistantMessage(session, (content) => content + delta);
      this.emitChanged(scope, store.upsert(updated));
      return;
    }
    const providerError = providerStopError(event);
    if (providerError) {
      this.markFailed(session.id, providerError);
      return;
    }
    if (isEventType(event, 'agent_end') || isEventType(event, 'agent_settled')) {
      this.completeActiveTurn(scope, store, session);
    }
  }

  private updateAssistantMessage(
    session: IrisAgentSessionInfo,
    update: (content: string) => string,
  ): IrisAgentSessionInfo {
    const activeTurnId = session.activeTurnId;
    if (!activeTurnId) return session;
    return {
      ...session,
      messages: session.messages.map((message) =>
        message.turnId === activeTurnId && message.role === 'assistant'
          ? { ...message, content: update(message.content) }
          : message,
      ),
    };
  }

  private completeActiveTurn(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: IrisAgentSessionInfo,
  ): void {
    const latest = store.get(session.id) ?? session;
    const activeTurnId = latest.activeTurnId;
    if (!activeTurnId) {
      this.emitChanged(scope, store.upsert({ ...latest, state: 'idle' }));
      return;
    }
    const completed = store.upsert({
      ...latest,
      state: 'idle',
      activeTurnId: null,
      turns: latest.turns.map((turn) =>
        turn.id === activeTurnId && turn.status === 'running'
          ? { ...turn, status: 'completed', completedAt: Date.now() }
          : turn,
      ),
    });
    this.hosts.get(latest.id)?.markIdle();
    this.emitChanged(scope, completed);
  }

  private updateRuntimeState(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: IrisAgentSessionInfo,
    state: AgentSessionRuntimeState,
  ): void {
    if (state === 'interrupted') {
      this.finishActiveTurnAs(scope, store, session, 'stopped', 'Stopped by user.');
      return;
    }
    const mapped = mapRuntimeState(state);
    if (!mapped) return;
    this.emitChanged(scope, store.upsert({ ...session, state: mapped }));
  }

  private async markFailed(sessionId: string, message: string): Promise<void> {
    const scope = this.currentScope;
    if (!scope) return;
    const store = await this.ensureStore(scope.root);
    const session = store.get(sessionId);
    if (!session) return;
    this.finishActiveTurnAs(scope, store, session, 'failed', message);
  }

  private finishActiveTurnAs(
    scope: ProjectScope,
    store: IrisAgentSessionStore,
    session: IrisAgentSessionInfo,
    status: 'failed' | 'stopped',
    message: string,
  ): void {
    const activeTurnId = session.activeTurnId;
    const updated = store.upsert({
      ...session,
      state: status === 'failed' ? 'failed' : 'idle',
      activeTurnId: null,
      lastError: message,
      turns: session.turns.map((turn) =>
        turn.id === activeTurnId
          ? { ...turn, status, completedAt: Date.now(), error: message }
          : turn,
      ),
    });
    this.emitChanged(scope, updated);
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

  private emitChanged(scope: ProjectScope, session: IrisAgentSessionInfo): void {
    this.emit('sessionChanged', { scope, session } satisfies IrisAgentSessionChangedPayload);
  }
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
  targetTurnId: string,
): IrisAgentSessionInfo {
  const targetIndex = session.turns.findIndex((turn) => turn.id === targetTurnId);
  if (targetIndex < 0) throw new Error('Rewind target turn was not found.');
  const targetTurn = session.turns[targetIndex];
  if (targetTurn?.status !== 'completed') {
    throw new Error('Rewind target must be a completed Iris Agent turn.');
  }
  const removedTurnIds = new Set(session.turns.slice(targetIndex + 1).map((turn) => turn.id));
  return {
    ...session,
    activeTurnId: null,
    state: 'idle',
    messages: session.messages.filter((message) => !removedTurnIds.has(message.turnId)),
    turns: session.turns.slice(0, targetIndex + 1),
    toolEvents: session.toolEvents.filter((event) => !removedTurnIds.has(event.turnId)),
    fileEffects: session.fileEffects.filter((effect) => !removedTurnIds.has(effect.turnId)),
    requestFacts: session.requestFacts.filter((facts) => !removedTurnIds.has(facts.turnId)),
  };
}

function textDelta(event: unknown): string | null {
  if (!isRecord(event) || event.type !== 'message_update') return null;
  const assistantEvent = event.assistantMessageEvent;
  if (!isRecord(assistantEvent) || assistantEvent.type !== 'text_delta') return null;
  return typeof assistantEvent.delta === 'string' ? assistantEvent.delta : null;
}

function providerStopError(event: unknown): string | null {
  if (!isRecord(event) || event.type !== 'message_update') return null;
  const assistantEvent = event.assistantMessageEvent;
  if (!isRecord(assistantEvent) || assistantEvent.type !== 'message_end') return null;
  const stopReason = assistantEvent.stopReason;
  return stopReason === 'error' ? 'Provider returned stopReason=error.' : null;
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
