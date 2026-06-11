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
  Settings,
  SettingsChangedEvent,
} from '@shared/types';
import type { SettingsManager } from './settings-manager';
import type { ProjectManager } from './project-manager';
import { logger } from './logger';

export function registerIpcHandlers(
  settingsManager: SettingsManager,
  projectManager: ProjectManager,
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
  window: BrowserWindow,
): () => void {
  const onSettings = (event: SettingsChangedEvent): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(EVENTS.SETTINGS_CHANGED, event);
    }
  };
  const onIrisChanged = (event: FsIrisChangedEvent): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(EVENTS.FS_IRIS_CHANGED, event);
    }
  };
  settingsManager.on('settingsChanged', onSettings);
  projectManager.on('irisChanged', onIrisChanged);
  return () => {
    settingsManager.off('settingsChanged', onSettings);
    projectManager.off('irisChanged', onIrisChanged);
  };
}
