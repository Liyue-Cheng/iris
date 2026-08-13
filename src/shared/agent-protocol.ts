import type { IrisAgentAnchor } from './types';

export const IRIS_AGENT_PROTOCOL_VERSION = 1 as const;

export type AgentToolName = 'read' | 'edit' | 'write' | 'terminal';

export interface AgentCorrelation {
  sessionId: string;
  requestId?: string;
  turnId?: string;
  toolCallId?: string;
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
    role: 'user' | 'assistant' | 'tool';
    content: string;
  }>;
}

export interface AgentWorkerInitRuntime {
  cwd: string;
  agentDir: string;
}

export type AgentToolOperationInput =
  | { tool: 'read'; operation: 'access' | 'readFile'; absolutePath: string }
  | { tool: 'edit'; operation: 'access' | 'readFile' | 'writeFile'; absolutePath: string; content?: string }
  | { tool: 'write'; operation: 'mkdir' | 'writeFile'; absolutePath: string; content?: string }
  | {
      tool: 'terminal';
      operation: 'exec';
      command: string;
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
        runtime: { piVersion: string; nodeVersion: string; historyRevision: number };
      }
    | { type: 'state'; state: AgentSessionRuntimeState }
    | { type: 'stream'; event: unknown }
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
  return ['requestId', 'turnId', 'toolCallId', 'terminalId'].every(
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
      (message.role === 'user' || message.role === 'assistant' || message.role === 'tool') &&
      typeof message.content === 'string',
  );
}

function isAnchor(value: unknown): value is IrisAgentAnchor {
  if (!isRecord(value) || typeof value.path !== 'string') return false;
  return value.kind === 'document' || value.kind === 'workspace';
}

function isInitRuntime(value: unknown): value is AgentWorkerInitRuntime {
  return isRecord(value) && typeof value.cwd === 'string' && typeof value.agentDir === 'string';
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
