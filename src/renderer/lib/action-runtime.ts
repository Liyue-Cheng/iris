import type { AppErrorDomain } from '@shared/app-error';
import { notify } from '@renderer/stores/notification-store';
import { translate } from '@renderer/i18n';

export interface UiAppError {
  domain: AppErrorDomain;
  code: string;
  message: string;
  retryable: boolean;
  incidentId?: string;
  requestId?: string;
  correlationId?: string;
  details?: unknown;
  cause: unknown;
}

export type ActionOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'cancelled' }
  | { status: 'failed'; error: UiAppError };

interface ErrorLike {
  domain?: unknown;
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
  incidentId?: unknown;
  requestId?: unknown;
  correlationId?: unknown;
  details?: unknown;
}

const APP_ERROR_DOMAINS = new Set<AppErrorDomain>([
  'app',
  'settings',
  'project',
  'prompt',
  'document',
  'asset',
  'git',
  'session',
  'shell',
  'clipboard',
  'ipc',
  'internal',
]);

export function normalizeUiError(cause: unknown): UiAppError {
  const error = cause && typeof cause === 'object' ? cause as ErrorLike : {};
  const domain =
    typeof error.domain === 'string' && APP_ERROR_DOMAINS.has(error.domain as AppErrorDomain)
      ? error.domain as AppErrorDomain
      : 'internal';
  const normalized: UiAppError = {
    domain,
    code: typeof error.code === 'string' ? error.code : 'Unexpected',
    message:
      typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : typeof cause === 'string'
          ? cause
          : translate('common.unknownError'),
    retryable: error.retryable === true,
    cause,
  };
  if (typeof error.incidentId === 'string') normalized.incidentId = error.incidentId;
  if (typeof error.requestId === 'string') normalized.requestId = error.requestId;
  if (typeof error.correlationId === 'string') normalized.correlationId = error.correlationId;
  if (error.details !== undefined) normalized.details = error.details;
  return normalized;
}

export async function attemptAction<T>(
  operation: () => Promise<T>,
): Promise<ActionOutcome<T>> {
  try {
    return { status: 'ok', value: await operation() };
  } catch (cause) {
    const error = normalizeUiError(cause);
    if (error.code === 'Cancelled' || error.code === 'Canceled') {
      return { status: 'cancelled' };
    }
    return { status: 'failed', error };
  }
}

export interface RunUserActionOptions {
  title: string;
  dedupeKey: string;
  sticky?: boolean;
  retryLabel?: string;
}

export async function runUserAction<T>(
  options: RunUserActionOptions,
  operation: () => Promise<T>,
): Promise<ActionOutcome<T>> {
  const outcome = await attemptAction(operation);
  if (outcome.status !== 'failed') return outcome;

  const retry = outcome.error.retryable
    ? () => {
        void runUserAction(options, operation);
      }
    : undefined;
  notify({
    dedupeKey: options.dedupeKey,
    level: 'error',
    title: options.title,
    message: outcome.error.message,
    domain: outcome.error.domain,
    ...(options.sticky !== undefined ? { sticky: options.sticky } : {}),
    ...(outcome.error.incidentId !== undefined
      ? { incidentId: outcome.error.incidentId }
      : {}),
    ...(retry ? {
      action: {
        label: options.retryLabel ?? translate('common.refresh'),
        run: retry,
      },
    } : {}),
  });
  return outcome;
}
