import type {
  IrisAgentAnchor,
  IrisAgentAttachment,
  IrisAgentImageMimeType,
  IrisAgentModelRef,
  IrisAgentProviderContextCall,
  IrisAgentReasoningLevel,
  IrisAgentThinkingLevel,
  IrisAgentLivePhase,
  IrisJsonValue,
} from './types';
import { IRIS_AGENT_IMAGE_MIME_TYPES } from './types';
export interface AgentTextEdit {
  oldText: string;
  newText: string;
}

export const IRIS_AGENT_PROTOCOL_VERSION = 17 as const;

/**
 * Largest single image the Agent will send to a provider, whether it was read
 * from the project or attached by the user. One number for both directions:
 * the limit is about context cost, and a provider does not care who chose the
 * picture.
 */
export const AGENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Images one user request may carry. */
export const AGENT_ATTACHMENT_MAX_COUNT = 5;

/** Decoded bytes one user request may carry across all its images. */
export const AGENT_ATTACHMENT_MAX_TOTAL_BYTES = 12 * 1024 * 1024;

/**
 * Long-edge ceiling the composer downscales to before uploading. Chosen so a
 * 4K screenshot lands inside a typical vision model's tile budget instead of
 * consuming a disproportionate part of the window on every subsequent request.
 */
export const AGENT_ATTACHMENT_MAX_EDGE = 1568;

export type AgentToolName =
  | 'read' | 'edit' | 'write' | 'terminal'
  | 'task_start' | 'task_get' | 'task_list' | 'task_cancel';
export type AgentTerminalIntent = 'information' | 'operation';

export interface AgentCorrelation {
  sessionId: string;
  workerEpoch?: number;
  intentId?: string;
  turnId?: string;
  invokeId?: string;
  attemptId?: string;
  providerMessageId?: string;
  toolCallId?: string;
  operationId?: string;
  terminalId?: string;
}

export type AgentSessionRuntimeState =
  | 'starting'
  | 'ready'
  | 'running'
  | 'waiting-tool'
  | 'retry-wait'
  | 'stopping'
  | 'idle'
  | 'interrupted'
  | 'paused';

export interface AgentTerminalSupervisionInput {
  terminalId: string;
  command: string;
  cursorStart: number;
  cursorEnd: number;
  overlapOutput: string;
  incrementalOutput: string;
  processState: 'running' | 'exited';
}

export interface AgentTerminalSupervisionResult {
  outcome: 'normal' | 'suspicious' | 'error';
  evidence?: string;
  usageTokens?: number;
}

/**
 * One piece of a message sent to the provider. Text stays a plain string on the
 * aggregate and on the wire; an image part is the only shape that carries bytes,
 * and it always carries the attachment identity alongside them so history can
 * be re-projected without re-reading the original file.
 */
export type AgentContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: IrisAgentAttachment; dataBase64: string };

/** A message's provider-facing content: text only, or text plus images. */
export type AgentMessageContent = string | AgentContentPart[];

/**
 * One image part of the request being sent right now. The current user request
 * travels as an assembled prompt string rather than as a projected history
 * message, so its images are handed over with it.
 */
export type AgentPromptImage = Extract<AgentContentPart, { type: 'image' }>;

/** Exact completed provider message, retained only for same-runtime replay. */
export interface AgentProviderReplay {
  api: string;
  provider: string;
  model: string;
  message: Record<string, IrisJsonValue>;
}

export interface AgentHistoryMessage {
  id: string;
  intentId: string;
  turnId?: string;
  role: 'user' | 'assistant' | 'tool';
  content: AgentMessageContent;
  createdAt: number;
  /**
   * Images this message contributed to the request. Kept beside `content`
   * because a tool result's readable text and its image bytes are persisted by
   * different mechanisms: the text is already in the Trace, the bytes are
   * content-addressed files the store hydrates on projection.
   */
  attachments?: IrisAgentAttachment[];
  toolCalls?: Array<{ id: string; tool: AgentToolName; input: unknown }>;
  toolCallId?: string;
  tool?: AgentToolName;
  isError?: boolean;
  providerReplay?: AgentProviderReplay;
}

export interface AgentHistorySnapshot {
  revision: number;
  anchor: IrisAgentAnchor;
  messages: AgentHistoryMessage[];
}

/**
 * The digest compares runtime identity between main and the Worker, so image
 * bytes are replaced by their content-addressed id. Attachments are immutable
 * and named by the sha256 of their bytes, so the id decides the bytes and the
 * digest stays both exact and cheap to compute.
 */
export function agentHistoryDigest(history: AgentHistorySnapshot): string {
  const text = JSON.stringify({
    revision: history.revision,
    anchor: history.anchor,
    messages: history.messages.map((message) => ({
      ...message,
      content: digestContent(message.content),
    })),
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function digestContent(content: AgentMessageContent): string | unknown[] {
  if (typeof content === 'string') return content;
  return content.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image', id: part.attachment.id });
}

export interface AgentWorkerInitRuntime {
  cwd: string;
  agentDir: string;
  providerProfileRoot: string;
  commandShell: AgentCommandShell;
}

export interface AgentWorkerExecutionRuntime {
  model: IrisAgentModelRef;
  providerProxy: AgentProviderProxy;
  reasoning?: {
    configured: IrisAgentReasoningLevel;
    effective: IrisAgentReasoningLevel;
    downgradeReason?: string;
  };
}

export type AgentProviderProxy =
  | { mode: 'direct' }
  | { mode: 'proxy'; url: string };

export interface AgentCommandShell {
  kind: 'powershell' | 'posix';
  executable: string;
  displayName: string;
}

export type AgentToolOperationInput =
  | { tool: 'read'; operation: 'access' | 'readFile'; absolutePath: string; offset?: number; limit?: number }
  | { tool: 'edit'; operation: 'access' | 'readFile' | 'writeFile'; absolutePath: string; edits?: AgentTextEdit[] }
  | { tool: 'write'; operation: 'mkdir'; absolutePath: string }
  | { tool: 'write'; operation: 'writeFile'; absolutePath: string; content: string }
  | {
      tool: 'terminal';
      operation: 'exec';
      command: string;
      intent: AgentTerminalIntent;
      /** Frontend-facing seconds. The tool schema requires this field. */
      timeout: number;
      cwd: string;
      successExitCodes?: number[];
      env?: Record<string, string | undefined>;
    }
  | { tool: 'task_start'; operation: 'start'; command: string; title: string; successExitCodes?: number[] }
  | { tool: 'task_get'; operation: 'get'; taskId: string; cursor?: string; maxBytes?: number }
  | { tool: 'task_list'; operation: 'list'; scope?: 'active' | 'all'; cursor?: string; limit?: number }
  | { tool: 'task_cancel'; operation: 'cancel'; taskId: string };

export type AgentToolOperationResult =
  | { kind: 'void'; message?: string }
  | { kind: 'file'; contentBase64: string }
  | {
      kind: 'image';
      mimeType: IrisAgentImageMimeType;
      contentBase64: string;
      bytes: number;
      width?: number;
      height?: number;
    }
  | {
      kind: 'terminal';
      exitCode: number | null;
      success: boolean;
      outputText: string;
      outputTruncated: boolean;
      terminalId: string;
      outputPath: string;
      shown: boolean;
      termination?: 'natural' | 'timeout' | 'aborted';
    }
  | {
      kind: 'task';
      taskId?: string;
      status?: 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'lost';
      outputText: string;
      outputTruncated?: boolean;
      logRef?: string;
    };

interface AgentProtocolEnvelope {
  version: typeof IRIS_AGENT_PROTOCOL_VERSION;
  correlation: AgentCorrelation;
  eventId?: string;
}

export type AgentWorkerRequest = AgentProtocolEnvelope &
  (
    | { type: 'initialize'; history: AgentHistorySnapshot; runtime: AgentWorkerInitRuntime }
    | {
        type: 'run';
        prompt: string;
        /**
         * Images the request being sent carries. The intent that owns them is
         * still running and therefore absent from `history`, so these are the
         * only place they can arrive.
         */
        attachments?: AgentPromptImage[];
        history: AgentHistorySnapshot;
        runtime: AgentWorkerExecutionRuntime;
      }
    | {
        type: 'resume';
        invokeOffset: number;
        /** Resume a provider-held logical Invoke instead of creating a new one. */
        invokeId?: string;
        /** Number of Attempts already recorded for the resumed Invoke. */
        attemptOffset?: number;
        history: AgentHistorySnapshot;
        runtime: AgentWorkerExecutionRuntime;
      }
    | { type: 'supervise-terminal'; supervisionId: string; input: AgentTerminalSupervisionInput }
    | { type: 'abort'; reason: 'user' | 'project-switch' | 'app-quit' }
    | { type: 'tool-result'; ok: true; result: AgentToolOperationResult }
    | { type: 'tool-result'; ok: false; error: string }
    | { type: 'event-ack'; eventId: string; ok: true }
    | { type: 'event-ack'; eventId: string; ok: false; error: string }
    | { type: 'shutdown' }
  );

export type AgentWorkerEvent = AgentProtocolEnvelope &
  (
    | {
        type: 'ready';
        runtime: {
          protocolVersion: typeof IRIS_AGENT_PROTOCOL_VERSION;
          executorVersion: string;
          nodeVersion: string;
          workerEpoch: number;
          historyRevision: number;
          historyMessageCount: number;
          historyDigest: string;
          commandShell: AgentCommandShell;
        };
      }
    | { type: 'state'; state: AgentSessionRuntimeState }
    | { type: 'assistant-phase'; phase: IrisAgentLivePhase; startedAt: number }
    | { type: 'assistant-text-delta'; delta: string }
    | { type: 'provider-message'; message: Record<string, unknown> }
    | { type: 'provider-context'; call: IrisAgentProviderContextCall }
    | {
        type: 'provider-attempt';
        phase: 'started' | 'failed' | 'aborted' | 'completed';
        index: number;
        error?: string;
      }
    | {
        type: 'execution-paused';
        reason: 'provider-exhausted' | 'worker-crashed' | 'auth-required' | 'runtime-error';
        message: string;
      }
    | { type: 'execution-settled' }
    | {
        type: 'terminal-supervision-result';
        supervisionId: string;
        result: AgentTerminalSupervisionResult;
      }
    | { type: 'tool-request'; input: AgentToolOperationInput }
    | { type: 'failure'; code: string; message: string }
    | { type: 'stopped'; reason: 'idle-timeout' | 'shutdown' }
  );

export function isAgentWorkerRequest(value: unknown): value is AgentWorkerRequest {
  if (!isRecord(value) || value.version !== IRIS_AGENT_PROTOCOL_VERSION) return false;
  if (!isCorrelation(value.correlation)) return false;
  switch (value.type) {
    case 'initialize':
      return isHistorySnapshot(value.history) && isInitRuntime(value.runtime);
    case 'run':
      return typeof value.prompt === 'string' && isHistorySnapshot(value.history) &&
        isExecutionRuntime(value.runtime) &&
        (value.attachments === undefined ||
          (Array.isArray(value.attachments) && value.attachments.every(isPromptImage)));
    case 'resume':
      return typeof value.invokeOffset === 'number' &&
        Number.isSafeInteger(value.invokeOffset) && value.invokeOffset >= 0 &&
        (value.invokeId === undefined || typeof value.invokeId === 'string') &&
        (value.attemptOffset === undefined ||
          (typeof value.attemptOffset === 'number' && Number.isSafeInteger(value.attemptOffset) && value.attemptOffset >= 0)) &&
        isHistorySnapshot(value.history) && isExecutionRuntime(value.runtime);
    case 'supervise-terminal':
      return typeof value.supervisionId === 'string' && isTerminalSupervisionInput(value.input);
    case 'abort':
      return value.reason === 'user' || value.reason === 'project-switch' || value.reason === 'app-quit';
    case 'tool-result':
      if (typeof value.ok !== 'boolean') return false;
      return value.ok ? isToolOperationResult(value.result) : typeof value.error === 'string';
    case 'event-ack':
      return typeof value.eventId === 'string' && value.eventId.length > 0 &&
        typeof value.ok === 'boolean' && (value.ok || typeof value.error === 'string');
    case 'shutdown':
      return true;
    default:
      return false;
  }
}

function isTerminalSupervisionInput(value: unknown): value is AgentTerminalSupervisionInput {
  return isRecord(value) && typeof value.terminalId === 'string' &&
    typeof value.command === 'string' && typeof value.cursorStart === 'number' &&
    typeof value.cursorEnd === 'number' && typeof value.overlapOutput === 'string' &&
    typeof value.incrementalOutput === 'string' &&
    (value.processState === 'running' || value.processState === 'exited');
}

function isCorrelation(value: unknown): value is AgentCorrelation {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
    return false;
  }
  if (
    value.workerEpoch !== undefined &&
    (typeof value.workerEpoch !== 'number' || !Number.isSafeInteger(value.workerEpoch) || value.workerEpoch < 0)
  ) {
    return false;
  }
  return ['intentId', 'turnId', 'invokeId', 'attemptId', 'providerMessageId', 'toolCallId', 'operationId', 'terminalId'].every(
    (key) => value[key] === undefined || typeof value[key] === 'string',
  );
}

function isHistorySnapshot(value: unknown): value is AgentHistorySnapshot {
  if (
    !isRecord(value) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    return false;
  }
  if (!isAnchor(value.anchor)) return false;
  if (!Array.isArray(value.messages)) return false;
  return value.messages.every((message) => {
    if (!isRecord(message) || typeof message.id !== 'string' ||
      typeof message.intentId !== 'string' ||
      (message.turnId !== undefined && typeof message.turnId !== 'string') ||
      (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') ||
      !isMessageContent(message.content) || typeof message.createdAt !== 'number') return false;
    if (message.attachments !== undefined &&
      (!Array.isArray(message.attachments) || !message.attachments.every(isAttachment))) return false;
    if (message.role === 'assistant') {
      if (message.providerReplay !== undefined && !isProviderReplay(message.providerReplay)) return false;
      return message.toolCalls === undefined || (
        Array.isArray(message.toolCalls) && message.toolCalls.every((call) =>
          isRecord(call) && typeof call.id === 'string' && isToolName(call.tool) && 'input' in call)
      );
    }
    if (message.role === 'tool') {
      return typeof message.turnId === 'string' && typeof message.toolCallId === 'string' &&
        isToolName(message.tool) &&
        (message.isError === undefined || typeof message.isError === 'boolean');
    }
    return true;
  });
}

function isMessageContent(value: unknown): value is AgentMessageContent {
  if (typeof value === 'string') return true;
  if (!Array.isArray(value)) return false;
  return value.every(isContentPart);
}

function isContentPart(value: unknown): value is AgentContentPart {
  if (!isRecord(value)) return false;
  if (value.type === 'text') return typeof value.text === 'string';
  return isPromptImage(value);
}

function isPromptImage(value: unknown): value is AgentPromptImage {
  return isRecord(value) && value.type === 'image' &&
    isAttachment(value.attachment) && typeof value.dataBase64 === 'string';
}

function isAttachment(value: unknown): value is IrisAgentAttachment {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && /^[0-9a-f]{64}$/u.test(value.id) &&
    typeof value.name === 'string' &&
    isImageMimeType(value.mimeType) &&
    typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes > 0 &&
    (value.width === undefined || (typeof value.width === 'number' && Number.isSafeInteger(value.width))) &&
    (value.height === undefined || (typeof value.height === 'number' && Number.isSafeInteger(value.height)));
}

function isImageMimeType(value: unknown): value is IrisAgentImageMimeType {
  return typeof value === 'string' &&
    (IRIS_AGENT_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

function isAnchor(value: unknown): value is IrisAgentAnchor {
  if (!isRecord(value) || typeof value.path !== 'string') return false;
  return value.kind === 'document' || value.kind === 'workspace';
}

function isToolName(value: unknown): value is AgentToolName {
  return value === 'read' || value === 'edit' || value === 'write' || value === 'terminal' ||
    value === 'task_start' || value === 'task_get' || value === 'task_list' || value === 'task_cancel';
}

function isInitRuntime(value: unknown): value is AgentWorkerInitRuntime {
  return (
    isRecord(value) &&
    typeof value.cwd === 'string' &&
    typeof value.agentDir === 'string' &&
    typeof value.providerProfileRoot === 'string' &&
    !Object.hasOwn(value, 'model') &&
    !Object.hasOwn(value, 'providerProxy') &&
    isCommandShell(value.commandShell)
  );
}

function isExecutionRuntime(value: unknown): value is AgentWorkerExecutionRuntime {
  return isRecord(value) && isModelRef(value.model) && isProviderProxy(value.providerProxy) &&
    (value.reasoning === undefined || isReasoningDecision(value.reasoning));
}

function isReasoningDecision(value: unknown): value is AgentWorkerExecutionRuntime['reasoning'] {
  return isRecord(value) && isReasoningLevel(value.configured) && isReasoningLevel(value.effective) &&
    (value.downgradeReason === undefined || typeof value.downgradeReason === 'string');
}

function isReasoningLevel(value: unknown): value is IrisAgentReasoningLevel {
  return value === 'off' || isThinkingLevel(value);
}

function isThinkingLevel(value: unknown): value is IrisAgentThinkingLevel {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' ||
    value === 'xhigh' || value === 'max';
}

function isProviderReplay(value: unknown): value is AgentProviderReplay {
  return isRecord(value) && typeof value.api === 'string' && typeof value.provider === 'string' &&
    typeof value.model === 'string' && isRecord(value.message) && isJsonValue(value.message);
}

function isJsonValue(value: unknown): value is IrisJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isProviderProxy(value: unknown): value is AgentProviderProxy {
  if (!isRecord(value)) return false;
  if (value.mode === 'direct') return true;
  if (value.mode !== 'proxy' || typeof value.url !== 'string') return false;
  try {
    const parsed = new URL(value.url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isModelRef(value: unknown): value is IrisAgentModelRef {
  return (
    isRecord(value) &&
    typeof value.provider === 'string' && value.provider.length > 0 &&
    typeof value.modelId === 'string' && value.modelId.length > 0
  );
}

function isCommandShell(value: unknown): value is AgentCommandShell {
  return (
    isRecord(value) &&
    (value.kind === 'powershell' || value.kind === 'posix') &&
    typeof value.executable === 'string' && value.executable.length > 0 &&
    typeof value.displayName === 'string' && value.displayName.length > 0
  );
}

function isToolOperationResult(value: unknown): value is AgentToolOperationResult {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'void') return true;
  if (value.kind === 'file') return typeof value.contentBase64 === 'string';
  if (value.kind === 'image') {
    return typeof value.contentBase64 === 'string' &&
      isImageMimeType(value.mimeType) &&
      typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes > 0 &&
      (value.width === undefined || typeof value.width === 'number') &&
      (value.height === undefined || typeof value.height === 'number');
  }
  if (value.kind === 'task') {
    return typeof value.outputText === 'string' &&
      (value.taskId === undefined || typeof value.taskId === 'string') &&
      (value.status === undefined || value.status === 'queued' || value.status === 'starting' ||
        value.status === 'running' || value.status === 'succeeded' || value.status === 'failed' ||
        value.status === 'canceled' || value.status === 'lost') &&
      (value.outputTruncated === undefined || typeof value.outputTruncated === 'boolean') &&
      (value.logRef === undefined || typeof value.logRef === 'string');
  }
  return (
    value.kind === 'terminal' &&
    (typeof value.exitCode === 'number' || value.exitCode === null) &&
    typeof value.success === 'boolean' &&
    typeof value.outputText === 'string' &&
    typeof value.outputTruncated === 'boolean' &&
    typeof value.terminalId === 'string' &&
    typeof value.outputPath === 'string' &&
    typeof value.shown === 'boolean' &&
    (value.termination === undefined || value.termination === 'natural' ||
      value.termination === 'timeout' || value.termination === 'aborted')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
