import type {
  IrisAgentAnchor,
  IrisAgentModelRef,
  IrisAgentProviderContextCall,
} from './types';

export const IRIS_AGENT_PROTOCOL_VERSION = 6 as const;

export type AgentToolName = 'read' | 'edit' | 'write' | 'terminal';
export type AgentTerminalIntent = 'information' | 'operation';

export interface AgentCorrelation {
  sessionId: string;
  workerEpoch?: number;
  requestId?: string;
  turnId?: string;
  toolCallId?: string;
  operationId?: string;
  terminalId?: string;
}

export type AgentSessionRuntimeState =
  | 'starting'
  | 'ready'
  | 'running'
  | 'waiting-tool'
  | 'stopping'
  | 'idle'
  | 'interrupted'
  | 'failed';

export interface AgentHistorySnapshot {
  revision: number;
  anchor: IrisAgentAnchor;
  messages: Array<{
    id: string;
    turnId: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    createdAt: number;
    providerMessage?: Record<string, unknown>;
  }>;
}

export function agentHistoryDigest(history: AgentHistorySnapshot): string {
  const text = JSON.stringify({
    revision: history.revision,
    anchor: history.anchor,
    messages: history.messages,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface AgentWorkerInitRuntime {
  cwd: string;
  agentDir: string;
  providerProfileRoot: string;
  model: IrisAgentModelRef;
  commandShell: AgentCommandShell;
  providerProxy: AgentProviderProxy;
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
  | { tool: 'read'; operation: 'access' | 'readFile'; absolutePath: string }
  | { tool: 'edit'; operation: 'access' | 'readFile' | 'writeFile'; absolutePath: string; content?: string }
  | { tool: 'write'; operation: 'mkdir' | 'writeFile'; absolutePath: string; content?: string }
  | {
      tool: 'terminal';
      operation: 'exec';
      command: string;
      intent: AgentTerminalIntent;
      cwd: string;
      timeout?: number;
      env?: Record<string, string | undefined>;
    };

export type AgentToolOperationResult =
  | { kind: 'void' }
  | { kind: 'file'; contentBase64: string }
  | {
      kind: 'terminal';
      exitCode: number | null;
      outputBase64: string;
      terminalId: string;
      outputPath: string;
      shown: boolean;
    };

interface AgentProtocolEnvelope {
  version: typeof IRIS_AGENT_PROTOCOL_VERSION;
  correlation: AgentCorrelation;
}

export type AgentWorkerRequest = AgentProtocolEnvelope &
  (
    | { type: 'initialize'; history: AgentHistorySnapshot; runtime: AgentWorkerInitRuntime }
    | { type: 'run'; prompt: string }
    | { type: 'abort'; reason: 'user' | 'project-switch' | 'app-quit' }
    | { type: 'tool-result'; ok: true; result: AgentToolOperationResult }
    | { type: 'tool-result'; ok: false; error: string }
    | { type: 'shutdown' }
  );

export type AgentWorkerEvent = AgentProtocolEnvelope &
  (
    | {
        type: 'ready';
        runtime: {
          protocolVersion: typeof IRIS_AGENT_PROTOCOL_VERSION;
          piVersion: string;
          nodeVersion: string;
          workerEpoch: number;
          historyRevision: number;
          historyMessageCount: number;
          historyDigest: string;
          model: IrisAgentModelRef;
          commandShell: AgentCommandShell;
        };
      }
    | { type: 'state'; state: AgentSessionRuntimeState }
    | { type: 'stream'; event: unknown }
    | { type: 'provider-context'; call: IrisAgentProviderContextCall }
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
      return typeof value.prompt === 'string';
    case 'abort':
      return value.reason === 'user' || value.reason === 'project-switch' || value.reason === 'app-quit';
    case 'tool-result':
      if (typeof value.ok !== 'boolean') return false;
      return value.ok ? isToolOperationResult(value.result) : typeof value.error === 'string';
    case 'shutdown':
      return true;
    default:
      return false;
  }
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
  return ['requestId', 'turnId', 'toolCallId', 'operationId', 'terminalId'].every(
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
  return value.messages.every(
    (message) =>
      isRecord(message) &&
      typeof message.id === 'string' &&
      typeof message.turnId === 'string' &&
      (message.role === 'user' || message.role === 'assistant' || message.role === 'tool') &&
      typeof message.content === 'string' &&
      typeof message.createdAt === 'number' &&
      (message.providerMessage === undefined || isRecord(message.providerMessage)),
  );
}

function isAnchor(value: unknown): value is IrisAgentAnchor {
  if (!isRecord(value) || typeof value.path !== 'string') return false;
  return value.kind === 'document' || value.kind === 'workspace';
}

function isInitRuntime(value: unknown): value is AgentWorkerInitRuntime {
  return (
    isRecord(value) &&
    typeof value.cwd === 'string' &&
    typeof value.agentDir === 'string' &&
    typeof value.providerProfileRoot === 'string' &&
    isModelRef(value.model) &&
    isCommandShell(value.commandShell) &&
    isProviderProxy(value.providerProxy)
  );
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
  return (
    value.kind === 'terminal' &&
    (typeof value.exitCode === 'number' || value.exitCode === null) &&
    typeof value.outputBase64 === 'string' &&
    typeof value.terminalId === 'string' &&
    typeof value.outputPath === 'string' &&
    typeof value.shown === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
