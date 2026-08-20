import { randomUUID } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import {
  IRIS_AGENT_PROTOCOL_VERSION,
  agentHistoryDigest,
  isAgentWorkerRequest,
  type AgentCorrelation,
  type AgentToolOperationInput,
  type AgentToolOperationResult,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from '@shared/agent-protocol';
import {
  IRIS_PI_VERSION,
  createIrisPiSession,
  currentIrisProviderToolCallId,
  normalizeIrisInterruptedAssistantMessage,
  storedPiCredentialSecrets,
  unwrapProviderErrorMessage,
  type IrisToolHostOperations,
} from './agent/pi-adapter';
import { collectKnownSecrets, sanitizeProviderPayload } from './agent/context-artifact';
import { loadStoredIrisAgentProviderProfiles } from './agent/provider-profiles';

if (!parentPort) throw new Error('Iris Agent Worker requires a worker_threads parent port');
const workerPort = parentPort;

type PendingTool = {
  resolve: (result: AgentToolOperationResult) => void;
  reject: (error: Error) => void;
};

type PendingEventAck = {
  resolve: () => void;
  reject: (error: Error) => void;
};

type AgentWorkerEventPayload<T = AgentWorkerEvent> = T extends AgentWorkerEvent
  ? Omit<T, 'version'>
  : never;

let runtime:
  | {
      session: Awaited<ReturnType<typeof createIrisPiSession>>['session'];
      unsubscribe: () => void;
      disposeProviderTransport: () => Promise<void>;
      cwd: string;
      agentDir: string;
    }
  | null = null;
let currentCorrelation: AgentCorrelation = { sessionId: 'unknown' };
let providerCallIndex = 0;
let providerFailure: string | null = null;
let currentProviderCallId: string | null = null;
let currentAttemptId: string | null = null;
let currentAttemptIndex = 0;
let currentProviderMessageId: string | null = null;
let terminalProviderFailure: string | null = null;
let userAbortRequested = false;
let pendingAssistantDelta: { correlation: AgentCorrelation; text: string } | null = null;
let pendingAssistantDeltaTimer: NodeJS.Timeout | null = null;
const pendingTools = new Map<string, PendingTool>();
const pendingEventAcks = new Map<string, PendingEventAck>();
let providerEventChain: Promise<void> = Promise.resolve();
const ASSISTANT_DELTA_CHUNK_CHARS = 1024;
const ASSISTANT_DELTA_FLUSH_MS = 16;

workerPort.on('message', (message: unknown) => {
  void handleMessage(message).catch((err) => {
    post({
      type: 'failure',
      correlation: currentCorrelation,
      code: err instanceof Error ? err.name : 'WorkerError',
      message: err instanceof Error ? err.message : String(err),
    });
    post({ type: 'state', correlation: currentCorrelation, state: 'paused' });
  });
});

async function handleMessage(message: unknown): Promise<void> {
  if (!isAgentWorkerRequest(message)) {
    post({
      type: 'failure',
      correlation: { sessionId: 'unknown' },
      code: 'ProtocolMismatch',
      message: 'Unsupported Iris Agent Worker protocol message',
    });
    return;
  }

  if (message.type === 'event-ack') {
    const pending = pendingEventAcks.get(message.eventId);
    if (!pending) return;
    pendingEventAcks.delete(message.eventId);
    if (message.ok) pending.resolve();
    else pending.reject(new Error(message.error));
    return;
  }

  if (message.type === 'initialize') {
    currentCorrelation = message.correlation;
    await initialize(message);
    return;
  }
  if (message.type === 'shutdown') {
    flushAssistantDelta();
    await disposeRuntime();
    post({ type: 'stopped', correlation: message.correlation, reason: 'shutdown' });
    workerPort.close();
    return;
  }
  if (message.type === 'abort') {
    userAbortRequested = true;
    rejectPendingTools('Iris Agent tool operation was interrupted.');
    try {
      await runtime?.session.abort();
    } finally {
      abortCurrentProviderAttempt();
      if (!runtime) post({ type: 'state', correlation: message.correlation, state: 'interrupted' });
    }
    return;
  }
  if (message.type === 'tool-result') {
    settleTool(message);
    return;
  }
  if (message.type === 'run') {
    if (!runtime) throw new Error('Iris Agent Worker has not been initialized');
    currentCorrelation = message.correlation;
    providerCallIndex = 0;
    providerFailure = null;
    currentProviderCallId = null;
    currentAttemptId = null;
    currentAttemptIndex = 0;
    currentProviderMessageId = null;
    userAbortRequested = false;
    providerEventChain = Promise.resolve();
    flushAssistantDelta();
    await runExecution(message.correlation, async () => {
      await runtime!.session.prompt(message.prompt, {
        expandPromptTemplates: false,
        source: 'interactive',
      });
    });
    return;
  }
  if (message.type === 'resume') {
    if (!runtime) throw new Error('Iris Agent Worker has not been initialized');
    currentCorrelation = message.correlation;
    providerCallIndex = Math.max(providerCallIndex, message.providerCallOffset);
    currentProviderCallId = null;
    currentAttemptId = null;
    currentAttemptIndex = 0;
    currentProviderMessageId = null;
    userAbortRequested = false;
    providerEventChain = Promise.resolve();
    flushAssistantDelta();
    removeTrailingUncommittedAssistant(runtime.session.agent.state.messages);
    await runExecution(message.correlation, () => runtime!.session.agent.continue());
  }
}

async function runExecution(
  correlation: AgentCorrelation,
  execute: () => Promise<void>,
): Promise<void> {
  terminalProviderFailure = null;
  post({ type: 'state', correlation, state: 'running' });
  try {
    await execute();
    await providerEventChain;
    flushAssistantDelta();
    if (userAbortRequested) {
      post({ type: 'state', correlation, state: 'interrupted' });
      return;
    }
    if (terminalProviderFailure) {
      post({
        type: 'execution-paused',
        correlation: correlationWithAttempt(),
        reason: providerPauseReason(terminalProviderFailure),
        message: terminalProviderFailure,
      });
      post({ type: 'state', correlation, state: 'paused' });
      return;
    }
    post({ type: 'execution-settled', correlation });
    post({ type: 'state', correlation, state: 'idle' });
  } catch (err) {
    if (userAbortRequested) {
      post({ type: 'state', correlation, state: 'interrupted' });
      return;
    }
    const wrapped = err instanceof Error ? err.message : String(err);
    const failure = unwrapProviderErrorMessage(wrapped, providerFailure);
    providerFailure = null;
    await failCurrentProviderAttempt(failure);
    post({
      type: 'execution-paused',
      correlation: correlationWithAttempt(),
      reason: providerPauseReason(failure),
      message: failure,
    });
    post({ type: 'state', correlation, state: 'paused' });
  }
}

async function initialize(message: Extract<AgentWorkerRequest, { type: 'initialize' }>): Promise<void> {
  await disposeRuntime();
  post({ type: 'state', correlation: message.correlation, state: 'starting' });
  const operations = createWorkerOperations();
  const providerProfileSecrets = (await loadStoredIrisAgentProviderProfiles(
    message.runtime.providerProfileRoot,
  ))
    .map((profile) => profile.apiKey);
  const knownSecrets = collectKnownSecrets([
    providerProfileSecrets,
    providerSecretEnvironment(),
  ]);
  const result = await createIrisPiSession({
    cwd: message.runtime.cwd,
    agentDir: message.runtime.agentDir,
    providerProfileRoot: message.runtime.providerProfileRoot,
    model: message.runtime.model,
    commandShell: message.runtime.commandShell,
    providerProxy: message.runtime.providerProxy,
    operations,
    history: message.history,
    onProviderPayload: async (payload, model) => {
      if (!currentCorrelation.turnId) return;
      await providerEventChain;
      if (!currentProviderCallId) {
        currentProviderCallId = randomUUID();
        currentAttemptIndex = 0;
      }
      currentAttemptId = randomUUID();
      currentProviderMessageId = randomUUID();
      currentAttemptIndex += 1;
      await postDurable({
        type: 'provider-attempt',
        correlation: correlationWithAttempt(),
        phase: 'started',
        index: currentAttemptIndex,
      });
      const payloadSecrets = collectKnownSecrets([
        storedPiCredentialSecrets(model.provider, message.runtime.agentDir),
        knownSecrets,
      ]);
      post({
        type: 'provider-context',
        correlation: correlationWithAttempt(),
        call: {
          index: ++providerCallIndex,
          capturedAt: Date.now(),
          provider: model.provider,
          model: model.id,
          api: model.api,
          payload: sanitizeProviderPayload(payload, payloadSecrets),
        },
      });
    },
    onProviderFailure: (failure, model) => {
      if (failure === null) {
        providerFailure = null;
        return;
      }
      const failureSecrets = collectKnownSecrets([
        storedPiCredentialSecrets(model.provider, message.runtime.agentDir),
        knownSecrets,
      ]);
      const sanitized = sanitizeProviderPayload(failure, failureSecrets);
      providerFailure = typeof sanitized === 'string' ? sanitized : failure;
    },
  });
  const unsubscribe = result.session.subscribe((event) => {
    providerEventChain = providerEventChain.then(() => handleProviderEvent(event));
  });
  runtime = {
    session: result.session,
    unsubscribe,
    disposeProviderTransport: result.disposeProviderTransport,
    cwd: message.runtime.cwd,
    agentDir: message.runtime.agentDir,
  };
  post({
    type: 'ready',
    correlation: message.correlation,
    runtime: {
      protocolVersion: IRIS_AGENT_PROTOCOL_VERSION,
      piVersion: IRIS_PI_VERSION,
      nodeVersion: process.versions.node,
      workerEpoch: message.correlation.workerEpoch ?? 0,
      historyRevision: message.history.revision,
      historyMessageCount: result.session.state.messages.length,
      historyDigest: agentHistoryDigest(message.history),
      model: message.runtime.model,
      commandShell: message.runtime.commandShell,
    },
  });
  post({ type: 'state', correlation: message.correlation, state: 'ready' });
}

function providerSecretEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        typeof value === 'string' &&
        /(?:api[_-]?key|token|secret|password|authorization|credential)/iu.test(name),
    ),
  ) as Record<string, string>;
}

function createWorkerOperations(): IrisToolHostOperations {
  return {
    read: {
      access: async (absolutePath) => {
        await requestTool({ tool: 'read', operation: 'access', absolutePath });
      },
      readFile: async (absolutePath) => {
        const result = await requestTool({ tool: 'read', operation: 'readFile', absolutePath });
        if (result.kind !== 'file') throw new Error('Iris Agent readFile returned a non-file result');
        return Buffer.from(result.contentBase64, 'base64');
      },
    },
    edit: {
      access: async (absolutePath) => {
        await requestTool({ tool: 'edit', operation: 'access', absolutePath });
      },
      readFile: async (absolutePath) => {
        const result = await requestTool({ tool: 'edit', operation: 'readFile', absolutePath });
        if (result.kind !== 'file') throw new Error('Iris Agent edit.readFile returned a non-file result');
        return Buffer.from(result.contentBase64, 'base64');
      },
      writeFile: async (absolutePath, content) => {
        await requestTool({ tool: 'edit', operation: 'writeFile', absolutePath, content });
      },
    },
    write: {
      mkdir: async (absolutePath) => {
        await requestTool({ tool: 'write', operation: 'mkdir', absolutePath });
      },
      writeFile: async (absolutePath, content) => {
        await requestTool({ tool: 'write', operation: 'writeFile', absolutePath, content });
      },
    },
    terminal: {
      exec: async (command, intent, cwd, options) => {
        const input: AgentToolOperationInput = {
          tool: 'terminal',
          operation: 'exec',
          command,
          intent,
          cwd,
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
          ...(options.env === undefined ? {} : { env: options.env }),
        };
        const result = await requestTool(input);
        if (result.kind !== 'terminal') {
          throw new Error('Iris Agent terminal returned a non-terminal result');
        }
        options.onData(Buffer.from(result.outputBase64, 'base64'));
        return { exitCode: result.exitCode };
      },
    },
  };
}

async function requestTool(input: AgentToolOperationInput): Promise<AgentToolOperationResult> {
  await providerEventChain;
  const operationId = randomUUID();
  const toolCallId = currentIrisProviderToolCallId() ?? operationId;
  const correlation: AgentCorrelation = {
    ...currentCorrelation,
    toolCallId,
    operationId,
  };
  post({ type: 'state', correlation, state: 'waiting-tool' });
  workerPort.postMessage({
    version: IRIS_AGENT_PROTOCOL_VERSION,
    type: 'tool-request',
    correlation,
    input,
  } satisfies AgentWorkerEvent);
  return new Promise<AgentToolOperationResult>((resolve, reject) => {
    pendingTools.set(operationId, { resolve, reject });
  }).finally(() => {
    post({ type: 'state', correlation: currentCorrelation, state: 'running' });
  });
}

function settleTool(message: Extract<AgentWorkerRequest, { type: 'tool-result' }>): void {
  const operationId = message.correlation.operationId ?? message.correlation.toolCallId;
  if (!operationId) return;
  const pending = pendingTools.get(operationId);
  if (!pending) return;
  pendingTools.delete(operationId);
  if (message.ok) pending.resolve(message.result);
  else pending.reject(new Error(message.error));
}

async function disposeRuntime(): Promise<void> {
  rejectPendingTools('Iris Agent Worker disposed while a tool call was pending');
  for (const [eventId, pending] of pendingEventAcks) {
    pendingEventAcks.delete(eventId);
    pending.reject(new Error('Iris Agent Worker disposed before a durable event was acknowledged.'));
  }
  if (!runtime) return;
  const current = runtime;
  runtime = null;
  current.unsubscribe();
  try {
    current.session.dispose();
  } finally {
    await current.disposeProviderTransport();
  }
}

function rejectPendingTools(message: string): void {
  for (const [operationId, pending] of pendingTools) {
    pendingTools.delete(operationId);
    pending.reject(new Error(message));
  }
}

function post(event: AgentWorkerEventPayload): void {
  workerPort.postMessage({ ...event, version: IRIS_AGENT_PROTOCOL_VERSION } as AgentWorkerEvent);
}

function postDurable(event: AgentWorkerEventPayload): Promise<void> {
  const eventId = randomUUID();
  return new Promise<void>((resolve, reject) => {
    pendingEventAcks.set(eventId, { resolve, reject });
    workerPort.postMessage({ ...event, eventId, version: IRIS_AGENT_PROTOCOL_VERSION } as AgentWorkerEvent);
  });
}

async function handleProviderEvent(event: unknown): Promise<void> {
  const projected = projectProviderFailure(event, providerFailure);
  if (projected.consumedFailure) providerFailure = null;
  const delta = assistantTextDelta(projected.event);
  if (delta) {
    queueAssistantDelta(delta, correlationForProviderMessage(projected.event));
    return;
  }
  flushAssistantDelta();
  if (isAssistantMessageEnd(projected.event)) {
    if (assistantStopReason(projected.event) === 'error') {
      const failure = assistantError(projected.event);
      terminalProviderFailure = failure;
      if (currentAttemptId && currentProviderCallId) {
        await postDurable({
          type: 'provider-attempt',
          correlation: correlationWithAttempt(),
          phase: 'failed',
          index: currentAttemptIndex,
          error: failure,
        });
      }
      currentAttemptId = null;
      return;
    }
    if (assistantStopReason(projected.event) === 'aborted') {
      const safeMessage = normalizeIrisInterruptedAssistantMessage(
        isRecord(projected.event) ? projected.event.message : undefined,
      );
      if (safeMessage) {
        await postDurable({
          type: 'provider-message',
          correlation: correlationForProviderMessage(projected.event),
          message: safeMessage,
        });
      }
      if (currentAttemptId && currentProviderCallId) {
        await postDurable({
          type: 'provider-attempt',
          correlation: correlationWithAttempt(),
          phase: 'aborted',
          index: currentAttemptIndex,
        });
      }
      terminalProviderFailure = null;
      currentAttemptId = null;
      return;
    }
    const message = messageFromEvent(projected.event);
    if (message) {
      await postDurable({
        type: 'provider-message', correlation: correlationForProviderMessage(projected.event), message,
      });
    }
    if (currentAttemptId && currentProviderCallId) {
      await postDurable({
        type: 'provider-attempt',
        correlation: correlationWithAttempt(),
        phase: 'completed',
        index: currentAttemptIndex,
      });
    }
    terminalProviderFailure = null;
    currentProviderCallId = null;
    currentAttemptId = null;
    currentAttemptIndex = 0;
    currentProviderMessageId = null;
    return;
  }
  if (isEventType(projected.event, 'auto_retry_start')) {
    post({ type: 'state', correlation: currentCorrelation, state: 'retry-wait' });
    return;
  }
  if (isEventType(projected.event, 'auto_retry_end')) {
    post({ type: 'state', correlation: currentCorrelation, state: 'running' });
    return;
  }
  if (isEventType(projected.event, 'agent_end') || isEventType(projected.event, 'agent_settled')) return;
  const message = messageFromEvent(projected.event);
  if (message) {
    await postDurable({
      type: 'provider-message', correlation: correlationForProviderMessage(projected.event), message,
    });
  }
}

function queueAssistantDelta(delta: string, correlation: AgentCorrelation): void {
  if (pendingAssistantDelta &&
    pendingAssistantDelta.correlation.providerMessageId !== correlation.providerMessageId) {
    flushAssistantDelta();
  }
  if (!pendingAssistantDelta) pendingAssistantDelta = { correlation: { ...correlation }, text: '' };
  pendingAssistantDelta.text += delta;
  if (pendingAssistantDelta.text.length >= ASSISTANT_DELTA_CHUNK_CHARS) {
    flushAssistantDelta();
    return;
  }
  if (!pendingAssistantDeltaTimer) {
    pendingAssistantDeltaTimer = setTimeout(flushAssistantDelta, ASSISTANT_DELTA_FLUSH_MS);
  }
}

function flushAssistantDelta(): void {
  if (pendingAssistantDeltaTimer) clearTimeout(pendingAssistantDeltaTimer);
  pendingAssistantDeltaTimer = null;
  const pending = pendingAssistantDelta;
  pendingAssistantDelta = null;
  if (!pending?.text) return;
  post({ type: 'assistant-text-delta', correlation: pending.correlation, delta: pending.text });
}

function jsonSafeEvent(event: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(event, (key, value: unknown) => {
        if (key === 'partial') return undefined;
        if (typeof value === 'function') return undefined;
        return value;
      }),
    );
  } catch {
    return {
      type: 'unserializable_event',
      summary: Object.prototype.toString.call(event),
    };
  }
}

function correlationWithAttempt(): AgentCorrelation {
  return {
    ...currentCorrelation,
    ...(currentProviderCallId ? { providerCallId: currentProviderCallId } : {}),
    ...(currentAttemptId ? { attemptId: currentAttemptId } : {}),
  };
}

function correlationForProviderMessage(event: unknown): AgentCorrelation {
  const message = isRecord(event) && isRecord(event.message) ? event.message : null;
  const explicitId = message && typeof message.id === 'string' ? message.id : null;
  if (message?.role === 'toolResult') {
    return {
      ...currentCorrelation,
      providerMessageId: explicitId ?? randomUUID(),
      ...(typeof message.toolCallId === 'string' ? { toolCallId: message.toolCallId } : {}),
    };
  }
  if (!currentProviderMessageId && explicitId) currentProviderMessageId = explicitId;
  if (!currentProviderMessageId) currentProviderMessageId = randomUUID();
  return { ...correlationWithAttempt(), providerMessageId: currentProviderMessageId };
}

async function failCurrentProviderAttempt(error: string): Promise<void> {
  if (!currentAttemptId || !currentProviderCallId) return;
  await postDurable({
    type: 'provider-attempt',
    correlation: correlationWithAttempt(),
    phase: 'failed',
    index: currentAttemptIndex,
    error,
  });
  currentAttemptId = null;
  currentProviderMessageId = null;
}

function abortCurrentProviderAttempt(): void {
  if (!currentAttemptId || !currentProviderCallId) return;
  post({
    type: 'provider-attempt',
    correlation: correlationWithAttempt(),
    phase: 'aborted',
    index: currentAttemptIndex,
  });
  currentAttemptId = null;
  currentProviderMessageId = null;
}

function isEventType(event: unknown, type: string): boolean {
  return isRecord(event) && event.type === type;
}

function isAssistantMessageEnd(event: unknown): boolean {
  return isRecord(event) && event.type === 'message_end' &&
    isRecord(event.message) && event.message.role === 'assistant';
}

function assistantTextDelta(event: unknown): string | null {
  if (!isRecord(event) || event.type !== 'message_update' || !isRecord(event.assistantMessageEvent)) return null;
  return event.assistantMessageEvent.type === 'text_delta' && typeof event.assistantMessageEvent.delta === 'string'
    ? event.assistantMessageEvent.delta
    : null;
}

function messageFromEvent(event: unknown): Record<string, unknown> | null {
  if (!isRecord(event) || event.type !== 'message_end' || !isRecord(event.message)) return null;
  if (event.message.role !== 'assistant' && event.message.role !== 'toolResult') return null;
  return jsonSafeEvent(event.message) as Record<string, unknown>;
}

function assistantStopReason(event: unknown): unknown {
  return isRecord(event) && isRecord(event.message) ? event.message.stopReason : undefined;
}

function assistantError(event: unknown): string {
  if (!isRecord(event) || !isRecord(event.message)) return 'Provider request failed.';
  return typeof event.message.errorMessage === 'string'
    ? event.message.errorMessage
    : 'Provider request failed.';
}

function providerPauseReason(message: string): 'provider-exhausted' | 'auth-required' | 'runtime-error' {
  if (/\b(?:401|403|unauthori[sz]ed|forbidden|authentication|api[ _-]?key)\b/iu.test(message)) {
    return 'auth-required';
  }
  return /\b(?:provider|http|429|5\d\d|rate limit|overload|network|socket|fetch|timeout)\b/iu.test(message)
    ? 'provider-exhausted'
    : 'runtime-error';
}

function removeTrailingUncommittedAssistant(messages: Array<{ role?: unknown; stopReason?: unknown }>): void {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')) messages.pop();
}

export function projectProviderFailure(
  event: unknown,
  capturedFailure: string | null,
): { event: unknown; consumedFailure: boolean } {
  if (!isRecord(event) || event.type !== 'message_end' || !isRecord(event.message)) {
    return { event, consumedFailure: false };
  }
  const message = event.message;
  if (message.role !== 'assistant' || message.stopReason !== 'error') {
    return { event, consumedFailure: false };
  }
  const wrapped = typeof message.errorMessage === 'string'
    ? message.errorMessage
    : 'Provider returned stopReason=error.';
  return {
    event: {
      ...event,
      message: {
        ...message,
        errorMessage: unwrapProviderErrorMessage(wrapped, capturedFailure),
      },
    },
    consumedFailure: capturedFailure !== null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
