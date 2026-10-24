import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { IpcMainInvokeEvent } from 'electron';
import type { SettingsManager } from './settings-manager';
import type { ProjectSettingsSnapshot } from '@shared/types';
import { CHANNELS } from '@shared/protocol';

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
import { beginRendererNavigation, beginWindowShutdown } from './window-lifecycle';
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
  const sender = { mainFrame };
  const win = { id: 876, webContents: sender };
  electron.window = win;
  const projectSettings = vi.fn(async () => snapshot);
  const detachAgentOutputs = vi.fn();
  const ctx = {
    win, terminalSessionManager: manager,
    agentSessionManager: { detachAllTerminalOutputs: detachAgentOutputs },
    projectManager: { getRoot: () => scope.root, projectSettings },
    gitManager: {}, projectRoot: scope.root, projectScope: scope,
    projectSwitchTail: Promise.resolve(), projectSwitching: false,
    rendererEpoch: 0, rendererNavigating: false, closing: false,
    outputAttachment: null, unwire() {},
  } as unknown as WindowContext;
  registerContext(ctx);
  registerIpcHandlers(settings);
  const event = (): IpcMainInvokeEvent => ({ sender, senderFrame: mainFrame }) as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, payload: unknown, from = event()) => electron.handlers.get(channel)!(from, payload);
  const session = () => manager.createSession({
    docPath: null, agentId: 'shell', projectRoot: scope.root, projectGeneration: 1, cols: 80, rows: 24,
  });
  return { ctx, manager, pty, spawn, session, invoke, event, projectSettings, detachAgentOutputs, emitData: (data: string) => onData(data) };
}

let active: ReturnType<typeof harness>;
beforeEach(() => { active = harness(); });
afterEach(async () => {
  removeContext(active.ctx.win.id);
  await active.manager.shutdown();
  vi.restoreAllMocks();
});

describe('renderer document and terminal ownership', () => {
  it('rejects requests from detached or non-main frames before creating a PTY', async () => {
    for (const detached of [true, false]) {
      const from = { ...active.event(), senderFrame: { detached } } as unknown as IpcMainInvokeEvent;
      expect(await active.invoke(CHANNELS.SESSION_OPEN, {
        expectedScope: scope, docPath: null, agentId: 'shell', cols: 80, rows: 24,
      }, from)).toMatchObject({ ok: false });
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

    beginRendererNavigation(ctx);
    expect(ctx.outputAttachment).toBeNull();
    expect(detachAgentOutputs).toHaveBeenCalledOnce();
    expect(manager.diagnostics()[0]).toMatchObject({
      output: { inFlightBytes: 0, deliveryEnabled: false }, flow: { paused: false, blockers: [] },
    });
    expect(pty.resume).toHaveBeenCalled();
    expect(manager.list()).toHaveLength(1);
    expect(await invoke(CHANNELS.SESSION_OUTPUT_ATTACH, attachment)).toMatchObject({ ok: false });

    // Even if Chromium reuses the same main frame, pre-navigation requests expire.
    ctx.rendererNavigating = false;
    expect(await invoke(CHANNELS.SESSION_OUTPUT_ATTACH, attachment, oldEvent)).toMatchObject({ ok: false });
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
    if (change === 'reload') { beginRendererNavigation(ctx); ctx.rendererNavigating = false; }
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
});
