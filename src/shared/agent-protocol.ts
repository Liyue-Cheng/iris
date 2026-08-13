export const IRIS_AGENT_PROTOCOL_VERSION = 1 as const;

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
  anchor: { kind: 'document'; path: string } | { kind: 'workspace'; path: string };
  messages: Array<{
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
  }>;
}

interface AgentProtocolEnvelope {
  version: typeof IRIS_AGENT_PROTOCOL_VERSION;
  correlation: AgentCorrelation;
}

export type AgentWorkerRequest = AgentProtocolEnvelope &
  (
    | { type: 'initialize'; history: AgentHistorySnapshot }
    | { type: 'run'; prompt: string }
    | { type: 'abort'; reason: 'user' | 'project-switch' | 'app-quit' }
    | { type: 'tool-result'; ok: boolean; content: string }
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
    | { type: 'tool-request'; name: 'read' | 'edit' | 'write' | 'terminal'; input: unknown }
    | { type: 'failure'; code: string; message: string }
    | { type: 'stopped'; reason: 'idle-timeout' | 'shutdown' }
  );

export function isAgentWorkerRequest(value: unknown): value is AgentWorkerRequest {
  if (!isRecord(value) || value.version !== IRIS_AGENT_PROTOCOL_VERSION) return false;
  if (!isCorrelation(value.correlation)) return false;
  switch (value.type) {
    case 'initialize':
      return isHistorySnapshot(value.history);
    case 'run':
      return typeof value.prompt === 'string';
    case 'abort':
      return value.reason === 'user' || value.reason === 'project-switch' || value.reason === 'app-quit';
    case 'tool-result':
      return typeof value.ok === 'boolean' && typeof value.content === 'string';
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
  if (!isRecord(value.anchor) || typeof value.anchor.path !== 'string') return false;
  if (value.anchor.kind !== 'document' && value.anchor.kind !== 'workspace') return false;
  if (!Array.isArray(value.messages)) return false;
  return value.messages.every(
    (message) =>
      isRecord(message) &&
      typeof message.id === 'string' &&
      (message.role === 'user' || message.role === 'assistant' || message.role === 'tool') &&
      typeof message.content === 'string',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
