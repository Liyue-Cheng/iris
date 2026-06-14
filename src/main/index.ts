/**
 * @file src/main/index.ts
 * @purpose Electron main-process entry: settings init → window → IPC.
 *
 * M0 scope: a single window. Session pool, file watcher, project management
 * arrive in M1/M3. The "bootstrap starting" log line is the smoke-test
 * milestone (scripts/smoke-launch.mjs pattern-matches it).
 */
import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JsonStore } from './persistence';
import { SettingsManager, settingsFilePath } from './settings-manager';
import { ProjectManager } from './project-manager';
import { SessionManager } from './session-manager';
import { registerIpcHandlers, wireBroadcasts } from './ipc';
import { getBuildType } from './build-type';
import { logger } from './logger';
import { CHANNELS, EVENTS } from '@shared/protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env.ELECTRON_RENDERER_URL;

console.log('[main] bootstrap starting');

// Portable GPU-cache fix (issue 2026-06-13-portable-gpu-cache创建失败): the
// single-instance lock below did NOT resolve the "Unable to create cache"
// error, so the root cause isn't multi-instance lock contention — it's the
// GPU shader disk cache failing to write under portable's constrained dir.
// Disabling that cache removes the failing write (shader cache only speeds
// up repeated shader compiles; steady-state is unaffected). Gated to
// portable so dev/installed behavior is untouched. Must run before app ready.
if (getBuildType() === 'portable') {
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
}

// Two instances sharing one Chromium profile (userData) also contend on the
// disk cache locks — keep the single-instance lock regardless: v1 manages
// one project at a time, so a second launch should focus the first window.
if (!app.requestSingleInstanceLock()) {
  console.log('[main] another instance holds the lock — quitting');
  app.quit();
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

const settingsManager = new SettingsManager(new JsonStore(settingsFilePath()));
const projectManager = new ProjectManager();
const sessionManager = new SessionManager(settingsManager);

// B3 close-time flush handshake: the window's close handler sends
// APP_FLUSH_BEFORE_QUIT and awaits this resolver; the renderer invokes
// APP_FLUSH_DONE once its editor flush settles.
let flushDoneResolve: (() => void) | null = null;
ipcMain.handle(CHANNELS.APP_FLUSH_DONE, () => {
  flushDoneResolve?.();
});

function createWindow(): BrowserWindow {
  // A coding tool carries a lot of information — open generously rather than
  // cramming three panes into a small window (round-3 验收反馈). Target a
  // large default but cap to the work area so small screens aren't overflowed.
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.min(1680, Math.round(workAreaSize.width * 0.92));
  const height = Math.min(1040, Math.round(workAreaSize.height * 0.92));

  const win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(1180, workAreaSize.width),
    minHeight: Math.min(720, workAreaSize.height),
    show: false,
    title: 'Iris',
    // Custom-drawn title bar (Marina M1-A): frame:false removes the OS bar;
    // TitleBar.tsx provides the drag region and caption buttons via window:* IPC.
    frame: false,
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

  // F12 / Ctrl+Shift+I toggle DevTools. Packed builds ship no application
  // menu, so Chromium never binds the shortcut itself — main must intercept
  // webContents input (Marina lesson; only diagnosis channel in packed mode).
  // Detached window: docked DevTools would squeeze the three-pane layout.
  win.webContents.on('before-input-event', (event, input) => {
    const isToggle =
      input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
    if (isToggle && input.type === 'keyDown') {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
      event.preventDefault();
    }
  });

  const unwire = wireBroadcasts(settingsManager, projectManager, sessionManager, win);
  win.on('closed', unwire);

  // uiZoom: native Chromium zoom (webContents), never CSS zoom — CSS zoom
  // breaks popup positioning math. Re-apply on every load (dev HMR reload
  // resets the factor).
  const applyZoom = (): void => {
    if (win.isDestroyed()) return;
    win.webContents.setZoomFactor(settingsManager.get().appearance.uiZoom);
  };
  win.webContents.on('did-finish-load', applyZoom);
  const onSettingsChanged = ({ changedKeys }: { changedKeys: string[] }): void => {
    if (changedKeys.includes('appearance.uiZoom')) applyZoom();
  };
  settingsManager.on('settingsChanged', onSettingsChanged);
  win.on('closed', () => settingsManager.off('settingsChanged', onSettingsChanged));

  // Close flow (B3 + confirmOnQuit). Two concerns, in order:
  //   1) flush unsaved editor work — main can't reach the editor state, so it
  //      asks the renderer to run its normal doc.save and waits for an ack
  //      (with a timeout so a wedged renderer never blocks quit);
  //   2) confirmOnQuit: warn when live sessions would be killed.
  // The flush defers the real close once; on re-entry `flushed` is true and we
  // fall through to the confirm dialog.
  let flushed = false;
  win.on('close', (e) => {
    if (!flushed && !win.webContents.isDestroyed()) {
      e.preventDefault();
      flushed = true;
      const done = new Promise<void>((resolve) => {
        flushDoneResolve = resolve;
      });
      win.webContents.send(EVENTS.APP_FLUSH_BEFORE_QUIT);
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
      void Promise.race([done, timeout]).then(() => {
        flushDoneResolve = null;
        if (!win.isDestroyed()) win.close();
      });
      return;
    }

    // confirmOnQuit: closing the window with live sessions kills agent work
    // mid-flight — ask first (Marina behavior.confirmOnQuit).
    if (!settingsManager.get().behavior.confirmOnQuit) return;
    const live = sessionManager.list().filter((s) => s.state !== 'exited').length;
    if (live === 0) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: 'Iris',
      message: `仍有 ${live} 个会话在运行`,
      detail: '退出会终止所有会话（包括正在工作的 agent）。',
    });
    // Cancel: re-arm the flush so a later close attempt flushes fresh edits.
    if (choice === 1) {
      e.preventDefault();
      flushed = false;
    }
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    // loadURL instead of loadFile: loadFile + query options misbehave inside
    // packed asar (Marina lesson); plain file URL is the stable path.
    const indexPath = resolve(__dirname, '../renderer/index.html');
    void win.loadURL(pathToFileURL(indexPath).href);
  }

  // Instruction logs (front-cpu debug console) print here. IRIS_DEVTOOLS=always
  // is the escape hatch for diagnosing startup-phase renderer errors in packed
  // builds (Marina's EASYTERM_DEVTOOLS pattern).
  if (isDev || process.env['IRIS_DEVTOOLS'] === 'always') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

app.whenReady().then(async () => {
  const source = await settingsManager.initialize();
  logger.info('main', `settings loaded from ${source} (${settingsFilePath()})`);

  registerIpcHandlers(settingsManager, projectManager, sessionManager);
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
  sessionManager.shutdown();
  void projectManager.close();
  void settingsManager.flush();
});
