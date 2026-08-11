import { CHANNELS } from '@shared/protocol';
import type { ProjectScope } from '@shared/types';
import { attemptAction } from './action-runtime';
import {
  dismissNotification,
  notify,
} from '@renderer/stores/notification-store';
import {
  hydrateSessions,
  sessionStore,
} from '@renderer/stores/session-store';
import { translate } from '@renderer/i18n';

const failureNotifications = new Map<string, string>();

function clearFailure(sessionId: string): void {
  sessionStore.clearDisconnected(sessionId);
  const notificationId = failureNotifications.get(sessionId);
  if (notificationId) dismissNotification(notificationId);
  failureNotifications.delete(sessionId);
}

async function sendSessionIo(
  channel: typeof CHANNELS.SESSION_INPUT | typeof CHANNELS.SESSION_RESIZE,
  sessionId: string,
  scope: ProjectScope,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const outcome = await attemptAction(() => window.api.invoke(channel, {
    sessionId,
    expectedScope: scope,
    ...payload,
  }));
  if (outcome.status === 'ok') {
    clearFailure(sessionId);
    return true;
  }
  if (outcome.status !== 'failed') return false;

  if (!failureNotifications.has(sessionId)) {
    sessionStore.markDisconnected(sessionId);
    const notificationId = notify({
      dedupeKey: `session:io:${sessionId}`,
      title: translate('errors.sessionDisconnected'),
      message: outcome.error.message,
      sticky: true,
      domain: 'session',
      ...(outcome.error.incidentId !== undefined
        ? { incidentId: outcome.error.incidentId }
        : {}),
    });
    failureNotifications.set(sessionId, notificationId);
    if (await hydrateSessions()) {
      if (sessionStore.has(sessionId)) clearFailure(sessionId);
    }
  }
  return false;
}

export function sendSessionInput(
  sessionId: string,
  scope: ProjectScope,
  data: string,
): Promise<boolean> {
  return sendSessionIo(CHANNELS.SESSION_INPUT, sessionId, scope, { data });
}

export function sendSessionResize(
  sessionId: string,
  scope: ProjectScope,
  cols: number,
  rows: number,
): Promise<boolean> {
  return sendSessionIo(CHANNELS.SESSION_RESIZE, sessionId, scope, { cols, rows });
}
