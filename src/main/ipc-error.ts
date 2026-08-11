import { AppError, type AppErrorDomain, type IpcRequestMeta, type SerializedAppError } from '@shared/app-error';

const DOMAIN_BY_PREFIX: Record<string, AppErrorDomain> = {
  app: 'app',
  settings: 'settings',
  project: 'project',
  workspace: 'project',
  prompt: 'prompt',
  'software-prompt': 'prompt',
  'project-prompt': 'prompt',
  doc: 'document',
  asset: 'asset',
  git: 'git',
  session: 'session',
  shell: 'shell',
  clipboard: 'clipboard',
};

interface StructuredError extends Error {
  code?: unknown;
  details?: unknown;
  retryable?: unknown;
}

function inferredDomain(channel: string, error: Error): AppErrorDomain {
  if (error.name === 'SettingsError') return 'settings';
  if (error.name === 'ProjectSettingsError') return 'project';
  if (error.name === 'ProjectError') return 'project';
  if (error.name === 'AssetError') return 'asset';
  if (error.name === 'GitError') return 'git';
  if (error.name === 'SessionManagerError') return 'session';
  if (error.name === 'SystemTerminalError') return 'session';
  return DOMAIN_BY_PREFIX[channel.split(':')[0] ?? ''] ?? 'internal';
}

export function serializeIpcError(
  channel: string,
  thrown: unknown,
  meta: IpcRequestMeta,
  incidentId: string,
): SerializedAppError {
  const error: StructuredError =
    thrown instanceof Error ? thrown as StructuredError : new Error(String(thrown));
  const appError = error instanceof AppError ? error : null;
  const serialized: SerializedAppError = {
    version: 1,
    incidentId,
    requestId: meta.requestId,
    domain: appError?.domain ?? inferredDomain(channel, error),
    code:
      appError?.code ??
      (typeof error.code === 'string' && error.code.length > 0 ? error.code : 'Unexpected'),
    message: error.message || 'An unexpected error occurred',
    retryable:
      appError?.retryable ??
      (typeof error.retryable === 'boolean' ? error.retryable : false),
  };
  if (meta.correlationId) serialized.correlationId = meta.correlationId;
  const details = appError?.details ?? error.details;
  if (details !== undefined) serialized.details = details;
  return serialized;
}
