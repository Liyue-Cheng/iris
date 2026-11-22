import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@shared/app-error';
import { CHANNELS } from '@shared/protocol';
import type { TerminalSessionInfo } from '@shared/types';
import { sendSessionInput, sendSessionResize } from './session-io';
import { acceptSessionRecord, applySessionChange, hydrateSessions, sessionStore } from '@renderer/stores/session-store';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import { clearNotifications, getNotifications } from '@renderer/stores/notification-store';

vi.mock('@renderer/i18n', () => ({ translate: (key: string) => key }));

const scope = { root: 'C:/project', generation: 1 };
const session: TerminalSessionInfo = {
  id: 'terminal', docPath: null, workspacePath: '.iris', agentId: 'shell', displayName: 'Shell',
  terminalTitle: null, projectRoot: scope.root, projectGeneration: 1,
  cols: 80, rows: 24, pid: 1, state: 'idle', createdAt: 1,
};
const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>();
function input(): Promise<void> { return sendSessionInput(session.id, scope, 'YQ=='); }
function resize(): Promise<void> { return sendSessionResize(session.id, scope, 100, 30); }
function disconnected(): boolean { return sessionStore.get().disconnectedSessionIds.has(session.id); }
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  projectScopeState.set(scope);
  projectScopeState.setSwitching(false);
  sessionStore.reset([session]);
  invoke.mockReset().mockImplementation(async channel =>
    channel === CHANNELS.SESSION_LIST ? { scope, sessions: [session] } : { accepted: true });
  vi.stubGlobal('window', { api: { invoke } });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  sessionStore.reset([], null);
  projectScopeState.set(null);
  projectScopeState.setSwitching(false);
  clearNotifications();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('terminal I/O ownership and recovery', () => {
  it('does not resurrect a destroyed terminal from a late list or creation receipt', async () => {
    const read = deferred();
    invoke.mockReturnValueOnce(read.promise);
    const hydration = hydrateSessions();
    acceptSessionRecord({ ...session, revision: 1 });
    applySessionChange(scope, 2, () => sessionStore.handleDestroyed(session.id));
    read.resolve({ scope, revision: 1, sessions: [session] });
    await hydration;
    acceptSessionRecord({ ...session, revision: 1 });
    expect(sessionStore.has(session.id)).toBe(false);
    await expect(input()).rejects.toMatchObject({ code: 'Cancelled' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('coalesces a sequence gap and replays only changes newer than the returned list', async () => {
    const read = deferred();
    invoke.mockReturnValueOnce(read.promise);
    acceptSessionRecord({ ...session, revision: 3 });
    applySessionChange(scope, 4, () => sessionStore.handlePatch(session.id, { state: 'exited' }));
    expect(invoke).toHaveBeenCalledTimes(1);
    read.resolve({ scope, revision: 2, sessions: [] });
    await vi.waitFor(() => expect(sessionStore.get().sessions[0]?.state).toBe('exited'));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('preserves a failure even if hydration still lists the session; never resends input', async () => {
    const failure = Object.assign(new Error('write failed'), { incidentId: 'incident-1' });
    invoke.mockRejectedValueOnce(failure);
    await expect(input()).rejects.toBe(failure);
    expect(disconnected()).toBe(true);
    expect(getNotifications()).toMatchObject([{ sticky: true, message: 'write failed', incidentId: 'incident-1' }]);
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([CHANNELS.SESSION_INPUT, CHANNELS.SESSION_LIST]);
    await input();
    expect(disconnected()).toBe(false);
    expect(getNotifications()).toHaveLength(0);
  });

  it('does not interpret a successful resize as recovery from a failed input write', async () => {
    invoke.mockRejectedValueOnce(new Error('write failed'));
    await expect(input()).rejects.toThrow('write failed');
    await resize();
    expect(disconnected()).toBe(true);
    expect(getNotifications()).toHaveLength(1);
    await input();
    expect(disconnected()).toBe(false);
    expect(getNotifications()).toHaveLength(0);
  });

  it('keeps failures until both failed channels have recovered', async () => {
    invoke.mockRejectedValueOnce(new Error('write failed'));
    await expect(input()).rejects.toThrow('write failed');
    invoke.mockRejectedValueOnce(new Error('resize failed'));
    await expect(resize()).rejects.toThrow('resize failed');
    expect(getNotifications()).toHaveLength(1);
    await input();
    expect(disconnected()).toBe(true);
    await resize();
    expect(disconnected()).toBe(false);
    expect(getNotifications()).toHaveLength(0);
  });

  it.each(['destroyed', 'reset', 'exited'] as const)('cleans notices when the session is %s', async kind => {
    invoke.mockRejectedValueOnce(new Error('failed'));
    await expect(input()).rejects.toThrow('failed');
    if (kind === 'destroyed') sessionStore.handleDestroyed(session.id);
    if (kind === 'reset') sessionStore.reset([]);
    if (kind === 'exited') sessionStore.handlePatch(session.id, { state: 'exited', exitCode: 0 });
    expect(getNotifications()).toHaveLength(0);
    expect(disconnected()).toBe(false);
  });

  it.each(['failure', 'success'] as const)('ignores a late %s from a previous project', async outcome => {
    const reply = deferred();
    invoke.mockReturnValueOnce(reply.promise);
    const request = input();
    const rejection = expect(request).rejects.toThrow();
    projectScopeState.set({ ...scope, generation: 2 });
    sessionStore.reset([]);
    if (outcome === 'failure') reply.reject(new Error('old request'));
    else reply.resolve({ accepted: true });
    await rejection;
    expect(disconnected()).toBe(false);
    expect(getNotifications()).toHaveLength(0);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('ignores a failed reply after its session was destroyed in the same project', async () => {
    const reply = deferred();
    invoke.mockReturnValueOnce(reply.promise);
    const request = input();
    const rejection = expect(request).rejects.toThrow('closed session');
    sessionStore.handleDestroyed(session.id);
    reply.reject(new Error('closed session'));
    await rejection;
    expect(getNotifications()).toHaveLength(0);
    expect(disconnected()).toBe(false);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('updates the notification to the remaining failure after one channel recovers', async () => {
    invoke.mockRejectedValueOnce(new Error('write failed'));
    await expect(input()).rejects.toThrow('write failed');
    invoke.mockRejectedValueOnce(new Error('resize failed'));
    await expect(resize()).rejects.toThrow('resize failed');
    await resize();
    expect(getNotifications()[0]?.message).toBe('write failed');
    expect(disconnected()).toBe(true);
  });

  it.each(['WindowClosed', 'WindowClosing', 'RendererDocumentInactive', 'StaleProjectScope', 'ProjectSwitchInProgress'])(
    'propagates %s without falsely marking the PTY disconnected', async code => {
      const error = new AppError('ipc', code, 'request retired');
      invoke.mockRejectedValueOnce(error);
      await expect(input()).rejects.toBe(error);
      expect(getNotifications()).toHaveLength(0);
      expect(disconnected()).toBe(false);
      expect(invoke).toHaveBeenCalledOnce();
    },
  );

  it('does not let an older failed response overwrite a newer successful input', async () => {
    const reply = deferred();
    invoke.mockReturnValueOnce(reply.promise);
    const old = input();
    const rejected = expect(old).rejects.toThrow('late failure');
    await input();
    reply.reject(new Error('late failure'));
    await rejected;
    expect(disconnected()).toBe(false);
    expect(getNotifications()).toHaveLength(0);
  });

  it('does not let an older successful response hide a newer failed input', async () => {
    const reply = deferred();
    invoke.mockReturnValueOnce(reply.promise);
    const old = input();
    invoke.mockRejectedValueOnce(new Error('new failure'));
    await expect(input()).rejects.toThrow('new failure');
    reply.resolve({ accepted: true });
    await old;
    expect(disconnected()).toBe(true);
    expect(getNotifications()[0]?.message).toBe('new failure');
  });

  it('does not reinstate a notice when slow hydration finishes after successful input', async () => {
    const snapshot = deferred();
    invoke.mockRejectedValueOnce(new Error('failed')).mockReturnValueOnce(snapshot.promise);
    const failed = input();
    const rejection = expect(failed).rejects.toThrow('failed');
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await input();
    snapshot.resolve({ scope, sessions: [session] });
    await rejection;
    expect(disconnected()).toBe(false);
    expect(getNotifications()).toHaveLength(0);
  });

  it.each(['missing', 'exited', 'switching'] as const)('rejects a %s session before invoking IPC', async kind => {
    if (kind === 'missing') sessionStore.reset([]);
    if (kind === 'exited') sessionStore.handlePatch(session.id, { state: 'exited' });
    if (kind === 'switching') projectScopeState.setSwitching(true);
    await expect(input()).rejects.toMatchObject({ code: 'Cancelled' });
    expect(invoke).not.toHaveBeenCalled();
    expect(getNotifications()).toHaveLength(0);
  });
});
