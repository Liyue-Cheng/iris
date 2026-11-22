import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { IpcMainInvokeEvent } from 'electron';
import type { SettingsManager } from './settings-manager';
import type { ProjectSettingsSnapshot } from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { EventEmitter } from 'node:events';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<any>>(),
  window: null as unknown,
}));
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd(), isPackaged: false },
  BrowserWindow: { fromWebContents: () => electron.window, getAllWindows: () => [] },
  ipcMain: { handle: (channel: string, handler: any) => electron.handlers.set(channel, handler) },
  clipboard: {}, dialog: {}, shell: {},
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('./agent/pi-adapter', () => ({}));

import { registerIpcHandlers } from './ipc';
import { registerContext, removeContext, type WindowContext } from './window-context';
import { wireRendererLifecycle, beginWindowShutdown } from './window-lifecycle';
import { TerminalSessionManager } from './terminal-session-manager';

const scope = { root: process.cwd(), generation: 1 };
const snapshot = {
  revision: 'revision', error: null,
  settings: { toolbar: { actions: [{ description: 'Run', command: 'echo hello', terminal: 'iris' }] } },
} as ProjectSettingsSnapshot;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  let onData = (_data: string): void => undefined;
  let onExit = (_event: { exitCode: number }): void => undefined;
  const pty = {
    pid: 42, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    onData: (listener: typeof onData) => { onData = listener; return { dispose() {} }; },
    onExit: (listener: typeof onExit) => { onExit = listener; return { dispose() {} }; },
    kill: vi.fn(() => onExit({ exitCode: 0 })),
  } as unknown as IPty;
  const settings = {
    get: () => ({
      agents: [{ id: 'shell', label: 'Shell', command: '' }],
      appearance: { theme: 'rose-pine' }, advanced: { activeIdleThresholdSeconds: 2 },
      project: { commandTrust: { [scope.root]: snapshot.revision } },
    }),
  } as unknown as SettingsManager;
  const spawn = vi.fn(() => pty);
  const manager = new TerminalSessionManager(settings, {
    spawnFn: spawn, processTreeKillFn: null, ptyExitWaitMs: 0,
  });
  const mainFrame = { detached: false };
  const sender = Object.assign(new EventEmitter(), { mainFrame });
  const win = { id: 876, webContents: sender };
  electron.window = win;
  const projectSettings = vi.fn(async () => snapshot);
  const detachAgentOutputs = vi.fn();
  const ctx = {
    win, terminalSessionManager: manager,
    agentSessionManager: { detachAllTerminalOutputs: detachAgentOutputs, documentSessions: vi.fn(async () => []) },
    projectManager: { getRoot: () => scope.root, projectSettings },
    gitManager: {}, projectRoot: scope.root, projectScope: scope,
    projectSwitchTail: Promise.resolve(), projectSwitching: false,
    rendererEpoch: 0, closing: false,
    outputAttachment: null, unwire() {},
  } as unknown as WindowContext;
  registerContext(ctx);
  wireRendererLifecycle(ctx);
  registerIpcHandlers(settings);
  const event = (): IpcMainInvokeEvent => ({ sender, senderFrame: mainFrame }) as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, payload: unknown, from = event()) => electron.handlers.get(channel)!(from, payload);
  const session = () => manager.createSession({
    docPath: null, agentId: 'shell', projectRoot: scope.root, projectGeneration: 1, cols: 80, rows: 24,
  });
  return {
    ctx, manager, pty, spawn, session, invoke, event, projectSettings, detachAgentOutputs,
    emitData: (data: string) => onData(data),
    commit: () => sender.emit('did-navigate', {}, 'file:///iris.html', -1, ''),
    emitNavigation: (name: string, ...args: unknown[]) => sender.emit(name, ...args),
  };
}

let active: ReturnType<typeof harness>;
beforeEach(() => { active = harness(); });
afterEach(async () => {
  removeContext(active.ctx.win.id);
  await active.manager.shutdown();
  vi.restoreAllMocks();
});

describe('renderer document and terminal ownership', () => {
  it('never closes newly linked sessions, including after an empty confirmation', async () => {
    const request = { expectedScope: scope, documentPaths: ['issue.md'] };
    const preview = await active.invoke(CHANNELS.DOCUMENT_SESSIONS_LIST, request);
    expect(preview).toMatchObject({ ok: true, value: [] });
    const session = active.session();
    active.manager.reanchor(session.id, 'issue.md');
    const close = await active.invoke(CHANNELS.DOCUMENT_SESSIONS_CLOSE, { ...request, confirmed: preview.value });
    expect(close).toMatchObject({ ok: false, error: { code: 'LinkedSessionsChanged' } });
    expect(active.pty.kill).not.toHaveBeenCalled();
    expect(active.manager.get(session.id)?.state).toBe('idle');
  });

  it.each([
    ['SessionProjectMismatch', { projectRoot: 'other' }],
    ['SessionGenerationMismatch', { projectGeneration: 2 }],
  ] as const)('distinguishes %s from a missing session', async (code, difference) => {
    const session = active.session();
    vi.spyOn(active.manager, 'get').mockReturnValueOnce({ ...session, ...difference });
    expect(await active.invoke(CHANNELS.SESSION_INPUT, {
      expectedScope: scope, sessionId: session.id, data: 'YQ==',
    })).toMatchObject({ ok: false, error: { code, details: { sessionId: session.id, activeScope: scope } } });
    expect(active.pty.write).not.toHaveBeenCalled();
  });

  it('rechecks anchors and only destroys a confirmed session in its original document', async () => {
    const request = { expectedScope: scope, documentPaths: ['issue.md'] };
    const session = active.session();
    active.manager.reanchor(session.id, 'issue.md');
    const preview = await active.invoke(CHANNELS.DOCUMENT_SESSIONS_LIST, request);
    const close = () => active.invoke(CHANNELS.DOCUMENT_SESSIONS_CLOSE, { ...request, confirmed: preview.value });
    active.manager.reanchor(session.id, 'other.md');
    expect(await close()).toMatchObject({ ok: true, value: [] });
    expect(active.pty.kill).not.toHaveBeenCalled();
    active.manager.reanchor(session.id, 'issue.md');
    expect(await close()).toMatchObject({ ok: true, value: [{ id: session.id }] });
    expect(active.pty.kill).toHaveBeenCalledOnce();
    expect(await active.invoke(CHANNELS.SESSION_INPUT, {
      expectedScope: scope, sessionId: session.id, data: 'YQ==',
    })).toMatchObject({ ok: false, error: {
      code: 'SessionNotFound', details: { windowId: 876, sessionId: session.id, sessionScope: null,
        lastClosure: { reason: 'document-status', scope },
      },
    } });
  });

  it('rejects requests from detached or non-main frames before creating a PTY', async () => {
    for (const detached of [true, false]) {
      const from = { ...active.event(), senderFrame: { detached } } as unknown as IpcMainInvokeEvent;
      expect(await active.invoke(CHANNELS.SESSION_OPEN, {
        expectedScope: scope, docPath: null, agentId: 'shell', cols: 80, rows: 24,
      }, from)).toMatchObject({ ok: false, error: { code: 'RendererDocumentInactive', domain: 'ipc' } });
    }
    expect(active.spawn).not.toHaveBeenCalled();
  });

  it('rejects both creation paths while shutdown is pending and after it completes', async () => {
    const { manager, session, spawn, pty } = active;
    session();
    const shutdown = manager.shutdown();
    expect(() => session()).toThrow('ManagerClosing');
    expect(() => manager.createCommandSession({
      actionIndex: 0, description: 'Late', command: 'echo late',
      projectRoot: scope.root, projectGeneration: 1, cols: 80, rows: 24,
    })).toThrow('ManagerClosing');
    await shutdown;
    await manager.shutdown();
    expect(() => session()).toThrow('ManagerClosing');
    expect(spawn).toHaveBeenCalledOnce();
    expect(pty.kill).toHaveBeenCalledOnce();
    expect(manager.list()).toEqual([]);
  });

  it('reload releases real renderer backpressure, retains the mirror, and rejects old attachments', async () => {
    const { ctx, manager, pty, session, invoke, event, emitData, detachAgentOutputs } = active;
    const terminal = session();
    const attachment = { expectedScope: scope, sessionId: terminal.id, attachmentId: 'old' };
    const oldEvent = event();
    expect(await invoke(CHANNELS.SESSION_OUTPUT_ATTACH, attachment, oldEvent)).toMatchObject({ ok: true });
    emitData('x'.repeat(400 * 1024));
    await vi.waitFor(() => {
      expect(manager.diagnostics()[0]).toMatchObject({
        mirror: { pendingBytes: 0 },
        flow: { paused: true, blockers: ['renderer'] },
      });
    });

    active.commit();
    expect(ctx.outputAttachment).toBeNull();
    expect(detachAgentOutputs).toHaveBeenCalledOnce();
    expect(manager.diagnostics()[0]).toMatchObject({
      output: { inFlightBytes: 0, deliveryEnabled: false }, flow: { paused: false, blockers: [] },
    });
    expect(pty.resume).toHaveBeenCalled();
    expect(manager.list()).toHaveLength(1);
    // Even if Chromium reuses the same main frame, pre-navigation requests expire.
    Object.defineProperty(oldEvent, 'senderFrame', {
      get: () => { throw new Error('Electron senderFrame getter accessed after navigation'); },
    });
    expect(await invoke(CHANNELS.SESSION_OUTPUT_ATTACH, attachment, oldEvent)).toMatchObject({
      ok: false, error: { code: 'RendererDocumentInactive', details: { reason: 'document-replaced' } },
    });
    expect(await invoke(CHANNELS.SESSION_OUTPUT_ATTACH, { ...attachment, attachmentId: 'new' })).toMatchObject({ ok: true });
    const replay = await manager.prepareReplay(terminal.id, 80, 24);
    expect(Buffer.from(replay!.data, 'base64').toString('utf8')).toContain('xxx');
  });

  it.each(['closing', 'reload', 'scope'] as const)('rejects a delayed toolbar launch after %s', async (change) => {
    const { ctx, invoke, projectSettings, spawn } = active;
    const pendingSettings = deferred<ProjectSettingsSnapshot>();
    projectSettings.mockReturnValueOnce(pendingSettings.promise);
    const launch = invoke(CHANNELS.PROJECT_COMMAND_RUN, {
      expectedScope: scope, actionIndex: 0, revision: snapshot.revision, cols: 80, rows: 24,
    });
    expect(projectSettings).toHaveBeenCalledOnce();
    if (change === 'closing') beginWindowShutdown(ctx);
    if (change === 'reload') active.commit();
    if (change === 'scope') ctx.projectScope = { ...scope, generation: 2 };
    pendingSettings.resolve(snapshot);
    expect(await launch).toMatchObject({ ok: false });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('continues to allow a current toolbar launch', async () => {
    expect(await active.invoke(CHANNELS.PROJECT_COMMAND_RUN, {
      expectedScope: scope, actionIndex: 0, revision: snapshot.revision, cols: 80, rows: 24,
    })).toMatchObject({ ok: true, value: { kind: 'iris' } });
    expect(active.spawn).toHaveBeenCalledOnce();
  });

  it.each(['blocked', 'stopped', 'download', 'failed', 'same-document', 'subframe'])(
    'preserves current input and output when a navigation is %s', async (kind) => {
      const { ctx, manager, session, invoke, event, emitNavigation, detachAgentOutputs } = active;
      const terminal = session();
      const request = event();
      const attachment = { expectedScope: scope, sessionId: terminal.id, attachmentId: 'current' };
      expect(await invoke(CHANNELS.SESSION_OUTPUT_ATTACH, attachment, request)).toMatchObject({ ok: true });
      emitNavigation('did-start-navigation', { isMainFrame: kind !== 'subframe', isSameDocument: kind === 'same-document' });
      if (kind === 'blocked') emitNavigation('will-navigate', { preventDefault: vi.fn() });
      if (kind === 'stopped' || kind === 'failed') emitNavigation('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', '', true);
      if (kind === 'same-document') emitNavigation('did-navigate-in-page', {}, '#heading', true);
      if (kind === 'subframe') emitNavigation('did-frame-navigate', {}, 'about:srcdoc', 200, 'OK', false);
      expect(ctx.rendererEpoch).toBe(0);
      expect(ctx.outputAttachment).toMatchObject({ attachmentId: 'current' });
      expect(detachAgentOutputs).not.toHaveBeenCalled();
      expect(manager.diagnostics()[0]).toMatchObject({ output: { deliveryEnabled: true } });
      expect(await invoke(CHANNELS.SESSION_INPUT, {
        expectedScope: scope, sessionId: terminal.id, data: 'YQ==',
      }, request)).toMatchObject({ ok: true, value: { accepted: true } });
      expect(active.pty.write).toHaveBeenCalledWith(Buffer.from('a'));
    },
  );

  it('does not cancel a delayed toolbar launch for an uncommitted navigation', async () => {
    const pendingSettings = deferred<ProjectSettingsSnapshot>();
    active.projectSettings.mockReturnValueOnce(pendingSettings.promise);
    const launch = active.invoke(CHANNELS.PROJECT_COMMAND_RUN, {
      expectedScope: scope, actionIndex: 0, revision: snapshot.revision, cols: 80, rows: 24,
    });
    active.emitNavigation('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    active.emitNavigation('will-navigate', { preventDefault: vi.fn() });
    pendingSettings.resolve(snapshot);
    expect(await launch).toMatchObject({ ok: true, value: { kind: 'iris' } });
    expect(active.spawn).toHaveBeenCalledOnce();
  });

  it('serializes a PTY write rejection as a failure instead of successful I/O', async () => {
    const terminal = active.session();
    vi.mocked(active.pty.write).mockImplementationOnce(() => { throw new Error('closed pipe'); });
    expect(await active.invoke(CHANNELS.SESSION_INPUT, {
      expectedScope: scope, sessionId: terminal.id, data: 'YQ==',
    })).toMatchObject({ ok: false, error: {
      code: 'SessionInputRejected', domain: 'session', retryable: false,
      details: { reason: 'pty-write-failed' },
    } });
    expect(active.pty.write).toHaveBeenCalledOnce();
  });

  it.each([CHANNELS.SESSION_INPUT, CHANNELS.SESSION_RESIZE])('rejects %s after the PTY has exited', async (channel) => {
    const terminal = active.session();
    active.pty.kill();
    expect(await active.invoke(channel, {
      expectedScope: scope, sessionId: terminal.id, data: 'YQ==', cols: 100, rows: 30,
    })).toMatchObject({ ok: false, error: { domain: 'session', details: { reason: 'pty-exited' } } });
    expect(active.pty.write).not.toHaveBeenCalled();
  });
});
