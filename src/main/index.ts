/**
 * @file src/main/index.ts
 * @purpose Electron main-process entry: settings init → window → IPC.
 *
 * M0 scope: a single window. Session pool, file watcher, project management
 * arrive in M1/M3. The "bootstrap starting" log line is the smoke-test
 * milestone (scripts/smoke-launch.mjs pattern-matches it).
 */
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';
import { dirname, isAbsolute, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JsonStore } from './persistence';
import { SettingsManager, settingsFilePath } from './settings-manager';
import { ProjectManager } from './project-manager';
import { SessionManager } from './session-manager';
import { registerIpcHandlers, wireBroadcasts } from './ipc';
import {
  allContexts,
  persistOpenRoots,
  registerContext,
  removeContext,
  type WindowContext,
} from './window-context';
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

// Dev runs out of the same default userData ("iris-app") as the packaged
// portable build, so the single-instance lock below treats `npm run dev` and a
// running portable as two instances of one profile — the second to launch
// quits. Give dev its own userData so the two have independent profiles (and
// independent locks + Chromium caches) and can run side by side. Must precede
// requestSingleInstanceLock, which keys the lock on the userData path.
if (isDev) {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

// Two instances sharing one Chromium profile (userData) contend on the disk
// cache locks — keep a single main process. A second launch must NOT continue
// the bootstrap below: app.quit() is async, so the module would keep running
// and build a second window that races the first on that shared cache lock
// (the overlap + instability + crashes the user hit, leaving orphaned PTYs).
// app.exit(0) terminates the loser synchronously, here and now, before any
// manager or window is constructed. The first instance gets a 'second-instance'
// event instead and surfaces a window itself (multi-window opening lands in a
// later phase; for now it just focuses the existing one).
if (!app.requestSingleInstanceLock()) {
  console.log('[main] another instance holds the lock — exiting');
  app.exit(0);
}
/** Find a project folder among a second launch's argv (e.g. `iris C:\proj`).
 *  Scans args after the exe for one that resolves to an existing directory. */
function parseProjectRootFromArgv(argv: string[], cwd: string): string | null {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i];
    if (!a || a.startsWith('-')) continue;
    const abs = isAbsolute(a) ? a : resolve(cwd, a);
    try {
      if (statSync(abs).isDirectory()) return abs;
    } catch {
      /* not a path — keep scanning */
    }
  }
  return null;
}

// A second launch opens a NEW window (VS Code-style multi-window) instead of
// just focusing the first. If the launch named a folder, bind the new window
// to it; otherwise fall back to the last project. (Runs only in the instance
// that holds the lock; the loser exited synchronously above.)
app.on('second-instance', (_event, argv, workingDirectory) => {
  const root =
    parseProjectRootFromArgv(argv, workingDirectory) ??
    settingsManager.get().project.lastRoot ??
    null;
  createWindow(root);
  persistOpenRoots(settingsManager);
});

// SettingsManager is machine-level — one instance shared across all windows.
// ProjectManager + SessionManager are per-window (see window-context.ts):
// each window binds one project and owns its own watcher + PTY pool.
const settingsManager = new SettingsManager(new JsonStore(settingsFilePath()));

/** Build a window's per-window managers, wire its broadcasts, register it. */
function createWindowContext(win: BrowserWindow, initialRoot: string | null): WindowContext {
  const projectManager = new ProjectManager();
  const sessionManager = new SessionManager(settingsManager);
  const unwire = wireBroadcasts(settingsManager, projectManager, sessionManager, win);
  const ctx: WindowContext = { win, projectManager, sessionManager, projectRoot: initialRoot, unwire };
  registerContext(ctx);
  return ctx;
}

// True once the app is quitting (window-all-closed → before-quit). While
// quitting, the per-window 'closed' teardown must NOT rewrite openRoots, or the
// last window to close would clear the restore list. Single-window closes while
// the app keeps running DO update it.
let isQuitting = false;

/** Tear down a window's context: detach broadcasts, kill its PTYs, close its
 *  watcher. Each window is independent, so this never touches other windows. */
function disposeWindowContext(id: number): void {
  const ctx = removeContext(id);
  if (!ctx) return;
  try {
    ctx.unwire();
  } catch {
    /* ignore */
  }
  ctx.sessionManager.shutdown();
  void ctx.projectManager.close();
  if (!isQuitting) persistOpenRoots(settingsManager);
}

// B3 close-time flush handshake: each window's close handler sends
// APP_FLUSH_BEFORE_QUIT and awaits its resolver; that window's renderer invokes
// APP_FLUSH_DONE once its editor flush settles. Keyed by window id so two
// windows closing at once don't resolve each other's handshake.
const flushResolvers = new Map<number, () => void>();
ipcMain.handle(CHANNELS.APP_FLUSH_DONE, (event) => {
  const id = BrowserWindow.fromWebContents(event.sender)?.id;
  if (id === undefined) return;
  flushResolvers.get(id)?.();
});

function createWindow(initialRoot: string | null): BrowserWindow {
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
    // A crashed renderer can neither show nor close its sessions — reclaim this
    // window's PTYs now so they don't orphan (Windows ConPTY children don't die
    // with us). destroy() skips the flush/confirm handshake with the dead
    // renderer (which would only hang); 'closed' then runs disposeWindowContext.
    const crashed =
      details.reason === 'crashed' ||
      details.reason === 'oom' ||
      details.reason === 'launch-failed' ||
      details.reason === 'integrity-failure';
    if (crashed && !win.isDestroyed()) win.destroy();
  });

  // Terminal links (WebLinksAddon + OSC 8 hyperlinks) trigger window.open,
  // which Electron intercepts by default and drops — so clicking a URL in the
  // terminal did nothing. Whitelist http/https/mailto → open in the system
  // browser; deny everything else (file://, javascript:, etc. — OSC 8 from an
  // agent could otherwise be coaxed into opening a local file). Marina
  // window-manager.ts:378.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
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

  // Per-window managers + broadcasts. The window owns these for its lifetime;
  // 'closed' tears them down (kills this window's PTYs, closes its watcher).
  const ctx = createWindowContext(win, initialRoot);
  win.on('closed', () => disposeWindowContext(win.id));

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
        flushResolvers.set(win.id, resolve);
      });
      win.webContents.send(EVENTS.APP_FLUSH_BEFORE_QUIT);
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
      void Promise.race([done, timeout]).then(() => {
        flushResolvers.delete(win.id);
        if (!win.isDestroyed()) win.close();
      });
      return;
    }

    // confirmOnQuit: closing the window with live sessions kills agent work
    // mid-flight — ask first (Marina behavior.confirmOnQuit).
    if (!settingsManager.get().behavior.confirmOnQuit) return;
    // This window's own sessions only — closing one window must not count
    // another window's live agents.
    const live = ctx.sessionManager.list().filter((s) => s.state !== 'exited').length;
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

  registerIpcHandlers(settingsManager);

  // "Open project in a new window" (VS Code-style). Lives here, not in ipc.ts,
  // because it creates a window. Optional root; with none, show the picker.
  ipcMain.handle(
    CHANNELS.WINDOW_OPEN_PROJECT,
    async (event, payload?: { root?: string }): Promise<{ opened: boolean }> => {
      let root = payload?.root ?? null;
      if (!root) {
        const parent = BrowserWindow.fromWebContents(event.sender);
        const r = await (parent
          ? dialog.showOpenDialog(parent, {
              title: '在新窗口打开项目',
              properties: ['openDirectory'],
            })
          : dialog.showOpenDialog({ title: '在新窗口打开项目', properties: ['openDirectory'] }));
        if (r.canceled || r.filePaths.length === 0) return { opened: false };
        root = r.filePaths[0] ?? null;
      }
      if (!root) return { opened: false };
      createWindow(root);
      persistOpenRoots(settingsManager);
      return { opened: true };
    },
  );

  // Restore the windows open at last quit: one per project root (multi-window).
  // Fall back to the deprecated lastRoot for settings written by v1.0, and to a
  // single empty window when there's no history. Each window's renderer learns
  // its bound root via WINDOW_BOOTSTRAP. A root that no longer opens surfaces
  // the in-app error state in its own window and never blocks the others.
  const restore = settingsManager.get().project;
  const roots =
    restore.openRoots.length > 0
      ? restore.openRoots
      : restore.lastRoot
        ? [restore.lastRoot]
        : [];
  if (roots.length === 0) createWindow(null);
  else for (const root of roots) createWindow(root);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(settingsManager.get().project.lastRoot ?? null);
    }
  });
});

app.on('window-all-closed', () => {
  // Windows-first app: quit when the last window closes (also on macOS for
  // now — revisit if a macOS build ever matters).
  app.quit();
});

app.on('before-quit', () => {
  // Snapshot the open windows for restore BEFORE tearing them down, then stop
  // the per-window teardown from rewriting openRoots as windows close.
  persistOpenRoots(settingsManager);
  isQuitting = true;
  for (const ctx of allContexts()) {
    ctx.sessionManager.shutdown();
    void ctx.projectManager.close();
  }
  void settingsManager.flush();
});

// Crash safety. node-pty children (on Windows: the ConPTY conhost + the agent
// CLI) do NOT die with the main process — an abnormal exit orphans them (the
// "后端进程没结束，任务管理器全杀才恢复" symptom). before-quit covers the
// graceful path; these cover the crashes: kill every PTY before the process
// goes down.
process.on('uncaughtException', (err) => {
  logger.error('main', 'uncaughtException — killing all sessions before exit', err);
  for (const ctx of allContexts()) {
    try {
      ctx.sessionManager.shutdown();
    } catch {
      /* best effort — we are already going down */
    }
  }
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error(
    'main',
    `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});
app.on('child-process-gone', (_e, details) => {
  logger.error('main', `child-process-gone: type=${details.type} reason=${details.reason}`);
});
