/**
 * @file src/main/ipc.ts
 * @purpose Register all ipcMain handlers and wire main → renderer event
 *   broadcasts. One registration function called once from index.ts.
 *
 * Channel names come from @shared/protocol; payload/response types from
 * @shared/types. The renderer reaches these through front-cpu's `ipc`
 * executor (instructions declare `config: { channel }`), so this file is
 * the main-process half of every IPC-bodied instruction.
 */
import { ipcMain, type BrowserWindow } from 'electron';
import { CHANNELS, EVENTS } from '@shared/protocol';
import type { DeepPartial, PingResult, Settings, SettingsChangedEvent } from '@shared/types';
import type { SettingsManager } from './settings-manager';
import { logger } from './logger';

export function registerIpcHandlers(settingsManager: SettingsManager): void {
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

  logger.info('ipc', 'handlers registered');
}

/** Forward settingsChanged events to a window. Returns an unsubscribe fn. */
export function wireSettingsBroadcast(
  settingsManager: SettingsManager,
  window: BrowserWindow,
): () => void {
  const listener = (event: SettingsChangedEvent): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(EVENTS.SETTINGS_CHANGED, event);
    }
  };
  settingsManager.on('settingsChanged', listener);
  return () => settingsManager.off('settingsChanged', listener);
}
