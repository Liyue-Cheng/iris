/**
 * @file src/main/ipc.ts
 * @purpose Register all ipcMain handlers and wire main → renderer event
 *   broadcasts. One registration function called once from index.ts.
 *
 * Channel names come from @shared/protocol; payload/response types from
 * @shared/types. The renderer reaches the verb channels through front-cpu's
 * `ipc` executor (instructions declare `config: { channel }`); the query
 * channels are projection reads called directly by stores/ISRs.
 */
import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { CHANNELS, EVENTS } from '@shared/protocol';
import type {
  DeepPartial,
  DocContent,
  FsIrisChangedEvent,
  IrisScanResult,
  PingResult,
  RawTreeNode,
  SessionExitedPayload,
  SessionInfo,
  SessionOutputPayload,
  SessionStateChangedPayload,
  Settings,
  SettingsChangedEvent,
} from '@shared/types';
import type { SettingsManager } from './settings-manager';
import type { ProjectManager } from './project-manager';
import type { SessionManager } from './session-manager';
import { logger } from './logger';

export function registerIpcHandlers(
  settingsManager: SettingsManager,
  projectManager: ProjectManager,
  sessionManager: SessionManager,
): void {
  ipcMain.handle(CHANNELS.APP_PING, (_event, payload: unknown): PingResult => {
    return {
      pong: true,
      echo: payload,
      time: new Date().toISOString(),
      pid: process.pid,
    };
  });

  ipcMain.handle(CHANNELS.SETTINGS_GET, (): Settings => settingsManager.get());

  ipcMain.handle(
    CHANNELS.SETTINGS_UPDATE,
    (_event, partial: DeepPartial<Settings>): Settings => {
      settingsManager.update(partial);
      return settingsManager.get();
    },
  );

  // ── project ────────────────────────────────────────────────────────

  ipcMain.handle(
    CHANNELS.PROJECT_OPEN,
    async (_event, payload: { root: string }): Promise<IrisScanResult> => {
      const result = await projectManager.open(payload.root);
      // Remember across restarts. Verb side effect, so it lives here in the
      // instruction body, not in some renderer afterthought.
      settingsManager.update({ project: { lastRoot: result.projectRoot } });
      return result;
    },
  );

  ipcMain.handle(CHANNELS.PROJECT_SCAN, (): Promise<IrisScanResult> => projectManager.scan());

  ipcMain.handle(
    CHANNELS.PROJECT_RAW_TREE,
    (): Promise<RawTreeNode | null> => projectManager.rawTree(),
  );

  ipcMain.handle(
    CHANNELS.DOC_READ,
    (_event, payload: { path: string }): Promise<DocContent> =>
      projectManager.readDoc(payload.path),
  );

  ipcMain.handle(
    CHANNELS.DOC_WRITE,
    (_event, payload: { path: string; content: string }): Promise<{ path: string }> =>
      projectManager.writeDoc(payload.path, payload.content),
  );

  ipcMain.handle(
    CHANNELS.DOC_CREATE,
    (
      _event,
      payload: { workspacePath: string; type: import('@shared/types').DocType; title: string },
    ): Promise<{ path: string }> => projectManager.createDoc(payload),
  );

  // ── sessions ───────────────────────────────────────────────────────

  ipcMain.handle(
    CHANNELS.SESSION_OPEN,
    (
      _event,
      payload: { docPath: string | null; agentId: string; cols: number; rows: number },
    ): SessionInfo => {
      const root = projectManager.getRoot();
      if (!root) throw new Error('[session:open] no project is open');
      return sessionManager.createSession({
        docPath: payload.docPath,
        agentId: payload.agentId,
        projectRoot: root,
        cols: payload.cols,
        rows: payload.rows,
      });
    },
  );

  ipcMain.handle(CHANNELS.SESSION_CLOSE, (_event, payload: { sessionId: string }): void => {
    sessionManager.closeSession(payload.sessionId);
  });

  ipcMain.handle(
    CHANNELS.SESSION_INPUT,
    (_event, payload: { sessionId: string; data: string }) =>
      sessionManager.sendInput(payload.sessionId, payload.data),
  );

  ipcMain.handle(
    CHANNELS.SESSION_RESIZE,
    (_event, payload: { sessionId: string; cols: number; rows: number }) =>
      sessionManager.resize(payload.sessionId, payload.cols, payload.rows),
  );

  ipcMain.handle(CHANNELS.SESSION_LIST, (): SessionInfo[] => sessionManager.list());

  ipcMain.handle(
    CHANNELS.SESSION_SCROLLBACK,
    (_event, payload: { sessionId: string }) =>
      sessionManager.getScrollbackForReplay(payload.sessionId),
  );

  ipcMain.handle(CHANNELS.DIALOG_PICK_FOLDER, async (event): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: '打开项目文件夹',
      properties: ['openDirectory'],
    });
    void event; // window-modal not needed for v1's single window
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  logger.info('ipc', 'handlers registered');
}

/** Forward manager events to a window. Returns an unsubscribe fn. */
export function wireBroadcasts(
  settingsManager: SettingsManager,
  projectManager: ProjectManager,
  sessionManager: SessionManager,
  window: BrowserWindow,
): () => void {
  const send = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  };
  const onSettings = (e: SettingsChangedEvent): void => send(EVENTS.SETTINGS_CHANGED, e);
  const onIrisChanged = (e: FsIrisChangedEvent): void => send(EVENTS.FS_IRIS_CHANGED, e);
  const onOutput = (e: SessionOutputPayload): void => send(EVENTS.SESSION_OUTPUT, e);
  const onState = (e: SessionStateChangedPayload): void => send(EVENTS.SESSION_STATE_CHANGED, e);
  const onExited = (e: SessionExitedPayload): void => send(EVENTS.SESSION_EXITED, e);
  const onDestroyed = (e: { sessionId: string }): void => send(EVENTS.SESSION_DESTROYED, e);

  settingsManager.on('settingsChanged', onSettings);
  projectManager.on('irisChanged', onIrisChanged);
  sessionManager.on('sessionOutput', onOutput);
  sessionManager.on('sessionStateChanged', onState);
  sessionManager.on('sessionExited', onExited);
  sessionManager.on('sessionDestroyed', onDestroyed);
  return () => {
    settingsManager.off('settingsChanged', onSettings);
    projectManager.off('irisChanged', onIrisChanged);
    sessionManager.off('sessionOutput', onOutput);
    sessionManager.off('sessionStateChanged', onState);
    sessionManager.off('sessionExited', onExited);
    sessionManager.off('sessionDestroyed', onDestroyed);
  };
}
