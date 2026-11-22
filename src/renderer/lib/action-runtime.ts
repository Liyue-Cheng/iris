import type { AppErrorDomain } from '@shared/app-error';
import type { ProjectScope } from '@shared/types';
import { dismissNotification, getNotifications, notify } from '@renderer/stores/notification-store';
import { projectScopeState, sameProjectScope } from '@renderer/stores/project-scope-state';
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

const RETIRED_REQUEST_CODES = new Set([
  'WindowClosed', 'WindowClosing', 'RendererDocumentInactive',
  'StaleProjectScope', 'ProjectSwitchInProgress',
]);

export function isRetiredRequestError(cause: unknown): boolean {
  return !!cause && typeof cause === 'object' &&
    'code' in cause && typeof cause.code === 'string' && RETIRED_REQUEST_CODES.has(cause.code);
}

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
  scope?: ProjectScope | null;
  isCurrent?: () => boolean;
  /** Independent writes/messages must retain failures even if another succeeds. */
  concurrency?: 'latest' | 'independent';
  /** A removed session must not keep offering commands against its old ID. */
  isRelevant?: () => boolean;
}

const actions = new Map<string, { latest: number; pending: number }>();
let actionSequence = 0;

export async function runUserAction<T>(
  options: RunUserActionOptions,
  operation: (isCurrent: () => boolean) => Promise<T>,
): Promise<ActionOutcome<T>> {
  const isCurrent = (): boolean =>
    (options.scope === undefined || sameProjectScope(options.scope, projectScopeState.get())) &&
    (options.isCurrent?.() ?? true);
  if (!isCurrent()) return { status: 'cancelled' };
  const key = JSON.stringify([options.scope?.root, options.scope?.generation, options.dedupeKey]);
  const state = actions.get(key) ?? { latest: 0, pending: 0 };
  const request = ++actionSequence;
  state.latest = request;
  state.pending++;
  actions.set(key, state);
  const latestOnly = options.concurrency !== 'independent';
  try {
    const outcome = await attemptAction(() => operation(isCurrent));
    if (!isCurrent() || (latestOnly && state.latest !== request)) return { status: 'cancelled' };
    const previous = getNotifications().find((notification) => notification.dedupeKey === options.dedupeKey);
    if (outcome.status === 'ok') {
      if (latestOnly && outcome.value !== false && previous) dismissNotification(previous.id);
      return outcome;
    }
    // Cancellation does not establish recovery from an earlier real failure.
    if (outcome.status === 'cancelled') return outcome;
    if (options.isRelevant && !options.isRelevant()) return { status: 'cancelled' };
    if (options.scope !== undefined && isRetiredRequestError(outcome.error)) return { status: 'cancelled' };

    const retry = outcome.error.retryable
      ? () => {
          if (!isCurrent() || options.isRelevant?.() === false || !getNotifications().includes(notification)) return;
          void runUserAction(options, operation).then((result) => {
            if (result.status === 'ok' && result.value !== false && getNotifications().includes(notification)) {
              dismissNotification(notification.id);
            }
          });
        }
      : undefined;
    const id = notify({
      dedupeKey: options.dedupeKey,
      level: 'error',
      title: options.title,
      message: outcome.error.message,
      domain: outcome.error.domain,
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
      ...(options.sticky !== undefined ? { sticky: options.sticky } : {}),
      ...(outcome.error.incidentId !== undefined ? { incidentId: outcome.error.incidentId } : {}),
      ...(retry ? { action: { label: options.retryLabel ?? translate('common.refresh'), run: retry } } : {}),
    });
    const notification = getNotifications().find((candidate) => candidate.id === id)!;
    return outcome;
  } finally {
    state.pending--;
    if (state.pending === 0) actions.delete(key);
  }
}

/** Bind notifications and retries to the project in which the user acted. */
export function runProjectAction<T>(
  options: RunUserActionOptions,
  operation: (isCurrent: () => boolean) => Promise<T>,
): Promise<ActionOutcome<T>> {
  return runUserAction({ ...options, scope: projectScopeState.get() }, operation);
}
