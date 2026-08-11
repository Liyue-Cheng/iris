import { afterEach, describe, expect, it } from 'vitest';
import { attemptAction, runUserAction } from './action-runtime';
import {
  clearNotifications,
  getNotifications,
  notify,
} from '@renderer/stores/notification-store';

afterEach(() => clearNotifications());

describe('renderer action runtime', () => {
  it('always resolves failures as outcomes', async () => {
    const outcome = await attemptAction(async () => {
      throw {
        domain: 'session',
        code: 'PtySpawnFailed',
        message: 'Could not start terminal',
        retryable: true,
        incidentId: 'incident-1',
      };
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      error: {
        domain: 'session',
        code: 'PtySpawnFailed',
        incidentId: 'incident-1',
      },
    });
  });

  it('shows and deduplicates failed user actions', async () => {
    const operation = async (): Promise<void> => {
      throw new Error('disk unavailable');
    };
    await runUserAction({ title: 'Save failed', dedupeKey: 'doc:save' }, operation);
    await runUserAction({ title: 'Save failed', dedupeKey: 'doc:save' }, operation);

    expect(getNotifications()).toHaveLength(1);
    expect(getNotifications()[0]).toMatchObject({
      title: 'Save failed',
      occurrences: 2,
      message: 'disk unavailable',
    });
  });

  it('merges direct notifications by dedupe key', () => {
    notify({ dedupeKey: 'watcher:git', title: 'Git watcher', message: 'first' });
    notify({ dedupeKey: 'watcher:git', title: 'Git watcher', message: 'second' });
    expect(getNotifications()[0]).toMatchObject({ message: 'second', occurrences: 2 });
  });
});
