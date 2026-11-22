import { AppError } from '@shared/app-error';
import { CHANNELS } from '@shared/protocol';
import type { ProjectScope } from '@shared/types';
import { attemptAction, type UiAppError } from './action-runtime';
import { dismissNotification, notify } from '@renderer/stores/notification-store';
import { hydrateSessions, sessionStore } from '@renderer/stores/session-store';
import { projectScopeState, sameProjectScope } from '@renderer/stores/project-scope-state';
import { translate } from '@renderer/i18n';

type IoChannel = typeof CHANNELS.SESSION_INPUT | typeof CHANNELS.SESSION_RESIZE;
interface IoState {
  scope: ProjectScope;
  nextRequest: number;
  pending: number;
  settled: Partial<Record<IoChannel, number>>;
  failures: Map<IoChannel, UiAppError>;
  notificationId: string | null;
}
const ioStates = new Map<string, IoState>();
const retiredRequestCodes = new Set([
  'WindowClosed', 'WindowClosing', 'RendererDocumentInactive',
  'StaleProjectScope', 'ProjectSwitchInProgress',
]);

function hasLiveSession(sessionId: string, scope: ProjectScope): boolean {
  return sameProjectScope(scope, projectScopeState.get()) &&
    sameProjectScope(scope, sessionStore.get().scope) &&
    sessionStore.get().sessions.some(session => session.id === sessionId &&
      session.projectRoot === scope.root && session.projectGeneration === scope.generation &&
      session.state !== 'exited');
}

function clearFailure(sessionId: string, state: IoState): void {
  if (state.notificationId) dismissNotification(state.notificationId);
  state.notificationId = null;
  sessionStore.clearDisconnected(sessionId);
}

function showFailure(sessionId: string, state: IoState, error: UiAppError): void {
  state.notificationId = notify({
    dedupeKey: `session:io:${sessionId}`,
    title: translate('errors.sessionDisconnected'),
    message: error.message,
    sticky: true,
    domain: 'session',
    ...(error.incidentId !== undefined ? { incidentId: error.incidentId } : {}),
  });
  sessionStore.markDisconnected(sessionId);
}

// Notifications and pending replies belong to the session, including when it
// disappears through a snapshot reset rather than a destroyed event.
sessionStore.subscribe(() => {
  for (const [sessionId, state] of ioStates) {
    if (hasLiveSession(sessionId, state.scope)) continue;
    ioStates.delete(sessionId);
    clearFailure(sessionId, state);
  }
});

function cancelledIo(): AppError<unknown> {
  return new AppError('session', 'Cancelled', 'Terminal request belongs to an inactive session');
}

/** Report a failure once, preserve its rejection, and never replay input. */
async function sendSessionIo(
  channel: IoChannel,
  sessionId: string,
  scope: ProjectScope,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!hasLiveSession(sessionId, scope) || projectScopeState.isSwitching()) throw cancelledIo();
  let state = ioStates.get(sessionId);
  if (!state) {
    state = { scope, nextRequest: 0, pending: 0, settled: {}, failures: new Map(), notificationId: null };
    ioStates.set(sessionId, state);
  }
  const request = ++state.nextRequest;
  state.pending++;
  try {
    const outcome = await attemptAction(() => window.api.invoke(channel, {
      sessionId, expectedScope: scope, ...payload,
    }));
    const current = ioStates.get(sessionId) === state && hasLiveSession(sessionId, scope) &&
      !projectScopeState.isSwitching();
    // Reply ordering matters independently for input and resize: a successful
    // resize does not establish that a rejected keyboard write has recovered.
    if (current && request > (state.settled[channel] ?? 0)) {
      state.settled[channel] = request;
      if (outcome.status === 'ok') {
        const recovered = state.failures.delete(channel);
        if (state.failures.size === 0) clearFailure(sessionId, state);
        else if (recovered) showFailure(sessionId, state, [...state.failures.values()].at(-1)!);
      } else if (outcome.status === 'failed' && (outcome.error.code === 'SessionNotFound' || outcome.error.code === 'SessionExited')) {
        // Main observed closure or exit ahead of this view. Refresh the session state.
        await hydrateSessions();
      } else if (outcome.status === 'failed' && !retiredRequestCodes.has(outcome.error.code)) {
        const firstFailure = state.failures.size === 0;
        state.failures.set(channel, outcome.error);
        showFailure(sessionId, state, outcome.error);
        // Hydration can remove an exited/missing session. Merely finding its
        // id in the list never proves that input or resize succeeded.
        if (firstFailure) await hydrateSessions();
      }
    }
    if (outcome.status === 'failed') throw outcome.error.cause;
    if (outcome.status === 'cancelled' || !current) throw cancelledIo();
  } finally {
    state.pending--;
    if (ioStates.get(sessionId) === state && state.pending === 0 && state.failures.size === 0) {
      ioStates.delete(sessionId);
    }
  }
}

export function sendSessionInput(sessionId: string, scope: ProjectScope, data: string): Promise<void> {
  return sendSessionIo(CHANNELS.SESSION_INPUT, sessionId, scope, { data });
}

export function sendSessionResize(
  sessionId: string, scope: ProjectScope, cols: number, rows: number,
): Promise<void> {
  return sendSessionIo(CHANNELS.SESSION_RESIZE, sessionId, scope, { cols, rows });
}
