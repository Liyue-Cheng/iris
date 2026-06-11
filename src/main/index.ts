/**
 * @file src/main/index.ts
 * @purpose Electron main-process entry: settings init → window → IPC.
 *
 * M0 scope: a single window. Session pool, file watcher, project management
 * arrive in M1/M3. The "bootstrap starting" log line is the smoke-test
 * milestone (scripts/smoke-launch.mjs pattern-matches it).
 */
import { app, BrowserWindow } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JsonStore } from './persistence';
import { SettingsManager, settingsFilePath } from './settings-manager';
import { ProjectManager } from './project-manager';
import { registerIpcHandlers, wireBroadcasts } from './ipc';
import { logger } from './logger';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env.ELECTRON_RENDERER_URL;

console.log('[main] bootstrap starting');

const settingsManager = new SettingsManager(new JsonStore(settingsFilePath()));
const projectManager = new ProjectManager();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: 'Iris',
    backgroundColor: '#191724', // rose-pine base; avoids white flash before CSS loads
    webPreferences: {
      preload: resolve(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      // sandbox must stay false: electron-vite emits ESM preload (index.mjs)
      // and sandboxed preloads only support CJS (Marina SEC-1 lesson).
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    logger.error('window', `preload-error: preload="${preloadPath}"`, error);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error('window', `render-process-gone: ${details.reason}`);
  });

  const unwire = wireBroadcasts(settingsManager, projectManager, win);
  win.on('closed', unwire);

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    // Instruction logs (front-cpu debug console) print here.
    win.webContents.openDevTools();
  } else {
    // loadURL instead of loadFile: loadFile + query options misbehave inside
    // packed asar (Marina lesson); plain file URL is the stable path.
    const indexPath = resolve(__dirname, '../renderer/index.html');
    void win.loadURL(pathToFileURL(indexPath).href);
  }

  return win;
}

app.whenReady().then(async () => {
  const source = await settingsManager.initialize();
  logger.info('main', `settings loaded from ${source} (${settingsFilePath()})`);

  registerIpcHandlers(settingsManager, projectManager);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Windows-first app: quit when the last window closes (also on macOS for
  // now — revisit if a macOS build ever matters).
  app.quit();
});

app.on('before-quit', () => {
  void projectManager.close();
  void settingsManager.flush();
});
