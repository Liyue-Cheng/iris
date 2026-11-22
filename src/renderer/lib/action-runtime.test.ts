import { afterEach, describe, expect, it, vi } from 'vitest';
import { attemptAction, runProjectAction, runUserAction } from './action-runtime';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import {
  clearNotifications,
  getNotifications,
  notify,
} from '@renderer/stores/notification-store';

afterEach(() => { clearNotifications(); projectScopeState.set(null); vi.useRealTimers(); });

const action = { title: 'Failed', dedupeKey: 'test:action' };
const scopeA = { root: 'C:/a', generation: 1 };
const scopeB = { root: 'C:/b', generation: 2 };

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

  it('replaces optional metadata, sticky state and retry actions with the new error', () => {
    vi.useFakeTimers();
    notify({ ...action, message: 'first', sticky: true, incidentId: 'old', domain: 'git', action: { label: 'retry', run() {} } });
    notify({ ...action, message: 'second' });
    expect(getNotifications()[0]).toMatchObject({ message: 'second', sticky: false, occurrences: 2 });
    expect(getNotifications()[0]!.incidentId).toBeUndefined();
    expect(getNotifications()[0]!.domain).toBeUndefined();
    expect(getNotifications()[0]!.action).toBeUndefined();
    vi.advanceTimersByTime(7000);
    expect(getNotifications()).toHaveLength(0);
  });

  it('retains independent failures when a different message succeeds', async () => {
    let fail!: (cause: Error) => void;
    const pending = new Promise<void>((_, reject) => { fail = reject; });
    const options = { ...action, concurrency: 'independent' as const };
    const older = runUserAction(options, () => pending);
    await runUserAction(options, async () => 'another message sent');
    fail(new Error('the first message failed'));
    expect((await older).status).toBe('failed');
    await runUserAction(options, async () => 'third message sent');
    expect(getNotifications()).toMatchObject([{ message: 'the first message failed' }]);
  });

  it('clears an independent failure only when that notification is successfully retried', async () => {
    const operation = vi.fn().mockRejectedValueOnce({ message: 'retry me', retryable: true }).mockResolvedValueOnce(true);
    await runUserAction({ ...action, concurrency: 'independent' }, operation);
    getNotifications()[0]!.action!.run();
    await vi.waitFor(() => expect(getNotifications()).toHaveLength(0));
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not equate cancellation or an explicit refusal with recovery', async () => {
    await runUserAction(action, async () => { throw new Error('still failed'); });
    await runUserAction(action, async () => false);
    await runUserAction(action, async () => { throw { code: 'Cancelled' }; });
    expect(getNotifications()).toMatchObject([{ message: 'still failed' }]);
  });

  it('removes project notices on switching and prevents retained retries from acting in the new project', async () => {
    projectScopeState.set(scopeA);
    const operation = vi.fn().mockRejectedValue({ message: 'temporary', retryable: true });
    await runProjectAction(action, operation);
    const retry = getNotifications()[0]!.action!.run;
    projectScopeState.set(scopeB);
    expect(getNotifications()).toHaveLength(0);
    retry();
    expect(operation).toHaveBeenCalledOnce();
  });

  it('reports real project failures and leaves global errors visible across a project switch', async () => {
    projectScopeState.set(scopeA);
    await runProjectAction(action, async () => { throw { code: 'EACCES', message: 'permission denied' }; });
    expect(getNotifications()).toMatchObject([{ message: 'permission denied' }]);
    await runUserAction({ ...action, dedupeKey: 'global' }, async () => { throw { code: 'WindowClosing', message: 'global failure' }; });
    projectScopeState.set(scopeB);
    expect(getNotifications()).toMatchObject([{ message: 'global failure' }]);
  });
});
