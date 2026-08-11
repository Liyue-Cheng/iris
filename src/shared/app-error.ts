export type AppErrorDomain =
  | 'app'
  | 'settings'
  | 'project'
  | 'prompt'
  | 'document'
  | 'asset'
  | 'git'
  | 'session'
  | 'shell'
  | 'clipboard'
  | 'ipc'
  | 'internal';

export interface IpcRequestMeta {
  requestId: string;
  correlationId?: string;
}

export interface IpcRequest<P> {
  meta: IpcRequestMeta;
  payload: P;
}

export interface SerializedAppError<TDetails = unknown> {
  version: 1;
  incidentId: string;
  requestId: string;
  correlationId?: string;
  domain: AppErrorDomain;
  code: string;
  message: string;
  details?: TDetails;
  retryable: boolean;
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SerializedAppError };

export interface PromptNotReadyIssue {
  layer: 'settings' | 'software' | 'project';
  path?: string;
  state: string;
  message?: string;
}

export interface PromptNotReadyDetails {
  repairable: boolean;
  issues: PromptNotReadyIssue[];
}

export type HealthDomain =
  | 'system'
  | 'project-watcher'
  | 'project-projection'
  | 'git-watcher'
  | 'git-projection'
  | 'session-projection'
  | 'prompt-projection';

export interface ServiceHealthChangedEvent {
  domain: HealthDomain;
  state: 'healthy' | 'degraded';
  projectScope: import('./types').ProjectScope | null;
  error?: SerializedAppError;
}

export interface AppErrorOptions<TDetails> {
  details?: TDetails;
  retryable?: boolean;
}

/** Error carrying only fields that are safe to serialize across IPC. */
export class AppError<TDetails = unknown> extends Error {
  readonly details?: TDetails;
  readonly retryable: boolean;

  constructor(
    readonly domain: AppErrorDomain,
    readonly code: string,
    message: string,
    options: AppErrorOptions<TDetails> = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

export class RemoteAppError<TDetails = unknown> extends Error {
  readonly version = 1;
  readonly incidentId: string;
  readonly requestId: string;
  readonly correlationId?: string;
  readonly domain: AppErrorDomain;
  readonly code: string;
  readonly details?: TDetails;
  readonly retryable: boolean;

  constructor(serialized: SerializedAppError<TDetails>) {
    super(serialized.message);
    this.name = 'RemoteAppError';
    this.incidentId = serialized.incidentId;
    this.requestId = serialized.requestId;
    this.domain = serialized.domain;
    this.code = serialized.code;
    this.retryable = serialized.retryable;
    if (serialized.correlationId !== undefined) this.correlationId = serialized.correlationId;
    if (serialized.details !== undefined) this.details = serialized.details;
  }
}

export function isIpcResult(value: unknown): value is IpcResult<unknown> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { ok?: unknown; value?: unknown; error?: unknown };
  if (candidate.ok === true) return 'value' in candidate;
  if (candidate.ok !== false || !candidate.error || typeof candidate.error !== 'object') {
    return false;
  }
  const error = candidate.error as Partial<SerializedAppError>;
  return (
    error.version === 1 &&
    typeof error.incidentId === 'string' &&
    typeof error.requestId === 'string' &&
    typeof error.domain === 'string' &&
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    typeof error.retryable === 'boolean'
  );
}
