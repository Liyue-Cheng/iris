/**
 * @file src/main/app-main.ts
 * @purpose Electron main-process implementation: settings init → window → IPC.
 *
 * Loaded lazily by index.ts ONLY in the instance that won the single-instance
 * lock. The losing instance never imports this module, so it never resolves
 * the externalized native backend (node-pty / @xterm / chokidar) — that
 * resolution reads package.json files out of the per-launch portable temp dir,
 * and racing it against the loser's own teardown (which deletes that temp dir)
 * was crashing the second launch with an ESM `package.json` ENOENT. Keeping the
 * loser featherweight (index.ts imports only `electron`) removes the race.
 *
 * Multi-window is unchanged: the loser still calls requestSingleInstanceLock in
 * index.ts (that is what fires our `second-instance` event), and we open the new
 * window here in the winning main process — VS Code's one-main-process model.
 */
import { app, BrowserWindow, dialog, screen, session as electronSession, shell } from 'electron';
import { dirname, isAbsolute, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { JsonStore } from './persistence';
import {
  projectRootsForStartup,
  SettingsManager,
  appDataDir,
  settingsFilePath,
} from './settings-manager';
import { ProjectManager } from './project-manager';
import { GitManager } from './git-manager';
import { SessionManager } from './session-manager';
import { IrisAgentSessionManager } from './agent/session-manager';
import { ensureFocusScriptCurrent } from './agent-injection';
import { registerIpcHandler, registerIpcHandlers, wireBroadcasts } from './ipc';
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
import { initializeMainI18n, mainT } from './i18n';
import { serializeIpcError } from './ipc-error';
import { externalUrl } from './app-info';
import type { ServiceHealthChangedEvent } from '@shared/app-error';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env.ELECTRON_RENDERER_URL;
const PROCESS_CRASH_CLEANUP_TIMEOUT_MS = 8000;

// NO GPU intervention here on purpose. The portable multi-window corruption
// (issue 2026-06-23-多窗口多项目) was traced to a portable-only GPU switch, NOT
// the window code — so portable now runs with the exact GPU config as the
// known-good installed build. Do not reintroduce `disableHardwareAcceleration`
// or `disable-gpu-shader-disk-cache`; see the issue doc for the full forensics.

// Dev/installed isolation (independent userData → independent single-instance
// lock + Chromium caches) now happens in index.ts BEFORE requestSingleInstanceLock:
// the lock is keyed on the userData dir, so the override must precede the lock.
// Doing it here was too late — the loser had already forwarded its argv and quit,
// leaving dev sharing the installed build's lock
// (issue 2026-06-25-开发版与安装版实例隔离).

logger.info(
  'boot',
  `app-main loaded pid=${process.pid} build=${getBuildType()} userData=${app.getPath('userData')}`,
);

/** Find a project folder among a second launch's argv (e.g. `iris C:\proj`).
 *  Scans args after the exe for one that resolves to an existing directory,
 *  skipping the portable temp extraction dir and the OS temp root so a bare
 *  portable re-launch never binds the new window to a throwaway temp path
 *  (which would vanish under the new window and break its terminal's cwd). */
function parseProjectRootFromArgv(argv: string[], cwd: string): string | null {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR ?? null;
  const tempRoot = tmpdir();
  const underVolatileDir = (abs: string): boolean => {
    const norm = abs.toLowerCase();
    if (norm.startsWith(tempRoot.toLowerCase())) return true;
    if (portableDir && norm.startsWith(portableDir.toLowerCase())) return true;
    return false;
  };
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i];
    if (!a || a.startsWith('-')) continue;
    const abs = isAbsolute(a) ? a : resolve(cwd, a);
    if (underVolatileDir(abs)) continue;
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
// to it; otherwise follow the startup-restore preference. (Runs only in the instance
// that holds the lock; the loser exited synchronously in index.ts after the
// requestSingleInstanceLock call that fired this very event.)
app.on('second-instance', (_event, argv, workingDirectory) => {
  // MUST NOT throw out of here: an uncaught error in this handler would reach
  // process.on('uncaughtException') below, which calls process.exit(1) — that
  // would take down the WHOLE app, including the already-open first window
  // (the "开窗口2 把窗口1 搞坏" symptom). Catch, log, and keep the app alive.
  try {
    const settings = settingsManager.get();
    const root =
      parseProjectRootFromArgv(argv, workingDirectory) ??
      projectRootsForStartup(settings).at(-1) ??
      null;
    logger.info('window', `second-instance: argv=${JSON.stringify(argv)} → root=${root ?? '∅'}`);
    createWindow(root);
    persistOpenRoots(settingsManager);
  } catch (err) {
    logger.error('window', 'second-instance handler failed — first window preserved', err);
  }
});

// SettingsManager is machine-level — one instance shared across all windows.
// ProjectManager + SessionManager are per-window (see window-context.ts):
// each window binds one project and owns its own watcher + PTY pool.
const settingsManager = new SettingsManager(new JsonStore(settingsFilePath()));

/** Build a window's per-window managers, wire its broadcasts, register it. */
function createWindowContext(win: BrowserWindow, initialRoot: string | null): WindowContext {
  const projectManager = new ProjectManager();
  const gitManager = new GitManager();
  const sessionManager = new SessionManager(settingsManager);
  const agentSessionManager = new IrisAgentSessionManager(app.getPath('userData'), projectManager, {
    appVersion: app.getVersion(),
    providerProfileRoot: appDataDir(),
    settingsManager,
    resolveProxy: (url) => electronSession.defaultSession.resolveProxy(url),
  });
  let ctx: WindowContext;
  const unwire = wireBroadcasts(
    settingsManager,
    projectManager,
    gitManager,
    sessionManager,
    agentSessionManager,
    () => ctx.projectScope,
    () => ctx.outputAttachment,
    win,
  );
  ctx = {
    win,
    projectManager,
    gitManager,
    sessionManager,
    agentSessionManager,
    projectRoot: initialRoot,
    projectScope: null,
    projectSwitching: false,
    projectSwitchTail: Promise.resolve(),
    outputAttachment: null,
    unwire,
  };
  registerContext(ctx);
  return ctx;
}

// True once the app is quitting (window-all-closed → before-quit). While
// quitting, the per-window 'closed' teardown must NOT rewrite openRoots, or the
// last window to close would clear the restore list. Single-window closes while
// the app keeps running DO update it.
let isQuitting = false;

const contextCleanupPromises = new Map<number, Promise<void>>();
const pendingContextDisposals = new Set<Promise<void>>();

/** Stop every backend owned by a window exactly once. The promise is shared by
 * the close handler, the closed-event disposer and before-quit so no caller can
 * race Electron teardown against PTY process-tree termination. */
function shutdownWindowContext(ctx: WindowContext): Promise<void> {
  const existing = contextCleanupPromises.get(ctx.win.id);
  if (existing) return existing;
  const cleanup = ctx.projectSwitchTail.catch(() => undefined).then(async () => {
    const results = await Promise.allSettled([
      ctx.sessionManager.shutdown(),
      ctx.agentSessionManager.shutdown(),
      ctx.projectManager.close(),
      ctx.gitManager.close(),
    ]);
    const names = ['sessions', 'iris-agent sessions', 'project watcher', 'git watcher'];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn(
          'window',
          `cleanup failed id=${ctx.win.id} backend=${names[index]}`,
          result.reason,
        );
      }
    });
  });
  contextCleanupPromises.set(ctx.win.id, cleanup);
  return cleanup;
}

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
  const cleanup = shutdownWindowContext(ctx);
  pendingContextDisposals.add(cleanup);
  void cleanup.finally(() => {
    pendingContextDisposals.delete(cleanup);
    contextCleanupPromises.delete(id);
  });
  if (!isQuitting) persistOpenRoots(settingsManager);
}

// B3 close-time flush handshake: each window's close handler sends
// APP_FLUSH_BEFORE_QUIT and awaits its resolver; that window's renderer invokes
// APP_FLUSH_DONE once its editor flush settles. Keyed by window id so two
// windows closing at once don't resolve each other's handshake.
const flushResolvers = new Map<number, (ok: boolean) => void>();
registerIpcHandler(CHANNELS.APP_FLUSH_DONE, (event, payload?: { ok?: boolean }) => {
  const id = BrowserWindow.fromWebContents(event.sender)?.id;
  if (id === undefined) return;
  flushResolvers.get(id)?.(payload?.ok !== false);
});

/**
 * Window icon for dev / Linux. In a packaged build the taskbar & exe icon come
 * from electron-builder (build/icon.ico), and build/ is not bundled into the
 * asar — so this resolves only in dev, where app.getAppPath() is the repo root.
 */
function windowIcon(): string | undefined {
  try {
    const p = resolve(app.getAppPath(), 'build/icon.png');
    statSync(p);
    return p;
  } catch {
    return undefined;
  }
}

function createWindow(initialRoot: string | null): BrowserWindow {
  // A coding tool carries a lot of information — open generously rather than
  // cramming three panes into a small window (round-3 验收反馈). Target a
  // large default but cap to the work area so small screens aren't overflowed.
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.min(1680, Math.round(workAreaSize.width * 0.92));
  const height = Math.min(1040, Math.round(workAreaSize.height * 0.92));
  const iconPath = windowIcon();

  const win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(1180, workAreaSize.width),
    minHeight: Math.min(720, workAreaSize.height),
    show: false,
    title: 'Iris',
    ...(iconPath ? { icon: iconPath } : {}),
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
      // backgroundThrottling:false — when a window is occluded/minimized/not
      // foreground, Chromium clamps setTimeout to ≥1s and can pause timers/rAF.
      // xterm drains its write buffer (and fires the replay-fence callback) on
      // a setTimeout, so a backgrounded window's first-load replay could stall
      // on the fence until the 5s failsafe fired (持久-2026-06-25). Keep-alive
      // removes replay on switch-backs; this protects the remaining first
      // mount, which can land while another (multi-window) Iris window is
      // foreground.
      backgroundThrottling: false,
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
    try {
      void shell.openExternal(externalUrl(url));
    } catch {
      // Deny unsupported or malformed protocols below.
    }
    return { action: 'deny' };
  });

  // A Markdown link without target=_blank can ask Chromium to replace the
  // Iris renderer itself. Renderer-owned navigation handles valid links;
  // deny every unhandled top-level navigation as the final safety boundary.
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
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
  win.on('unresponsive', () => {
    logger.error(
      'window',
      `unresponsive terminal=${JSON.stringify(ctx.sessionManager.diagnostics())}`,
    );
  });
  win.on('responsive', () => {
    logger.info(
      'window',
      `responsive terminal=${JSON.stringify(ctx.sessionManager.diagnostics())}`,
    );
  });
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
  let backendsReadyToClose = false;
  let backendCleanupStarted = false;
  win.on('close', (e) => {
    if (!flushed && !win.webContents.isDestroyed()) {
      e.preventDefault();
      flushed = true;
      const done = new Promise<boolean>((resolve) => {
        flushResolvers.set(win.id, resolve);
      });
      win.webContents.send(EVENTS.APP_FLUSH_BEFORE_QUIT);
      // doc.save itself has a 10s execution timeout. Give it room to settle,
      // but never interpret a silent or wedged renderer as permission to
      // discard a draft: timeout cancels this close attempt.
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 11_000));
      void Promise.race([done, timeout]).then((ok) => {
        flushResolvers.delete(win.id);
        if (!ok) {
          flushed = false;
          return;
        }
        if (!win.isDestroyed()) win.close();
      });
      return;
    }

    if (backendsReadyToClose) return;
    if (backendCleanupStarted) {
      e.preventDefault();
      return;
    }

    // confirmOnQuit: closing the window with live sessions kills agent work
    // mid-flight — ask first (Marina behavior.confirmOnQuit).
    if (settingsManager.get().behavior.confirmOnQuit) {
      // This window's own sessions only — closing one window must not count
      // another window's live agents.
      const live = ctx.sessionManager.list().filter((s) => s.state !== 'exited').length;
      if (live > 0) {
        const choice = dialog.showMessageBoxSync(win, {
          type: 'warning',
          buttons: [mainT('app.quit'), mainT('common.cancel')],
          defaultId: 1,
          cancelId: 1,
          title: 'Iris',
          message: mainT('app.quitMessage', { count: live }),
          detail: mainT('app.quitDetail'),
        });
        // Cancel: re-arm the flush so a later close attempt flushes fresh edits.
        if (choice === 1) {
          e.preventDefault();
          flushed = false;
          return;
        }
      }
    }

    e.preventDefault();
    backendCleanupStarted = true;
    void shutdownWindowContext(ctx).finally(() => {
      backendsReadyToClose = true;
      if (!win.isDestroyed()) win.close();
    });
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

  logger.info(
    'window',
    `window opened id=${win.id} root=${initialRoot ?? '∅'} total=${BrowserWindow.getAllWindows().length}`,
  );
  return win;
}

app.whenReady().then(async () => {
  const source = await settingsManager.initialize();
  await initializeMainI18n(settingsManager.get().locale, app.getLocale());
  settingsManager.on('settingsChanged', ({ settings }) => {
    void initializeMainI18n(settings.locale, app.getLocale());
  });
  logger.info('main', `settings loaded from ${source} (${settingsFilePath()})`);

  // The generated hook payload is app-owned and all CLI configs point to its
  // stable machine path. Refresh it before any window can spawn a terminal;
  // otherwise a previous Iris version can silently turn a valid hook into an
  // empty injection. A write failure is surfaced in logs/settings state but
  // must not prevent the application itself from opening.
  try {
    const result = await ensureFocusScriptCurrent();
    logger.info('agent', `focus-context script sync: ${result.action} (${result.path})`);
  } catch (err) {
    logger.error('agent', 'focus-context script auto-sync failed', err);
  }

  registerIpcHandlers(settingsManager);

  // "Open project in a new window" (VS Code-style). Lives here, not in ipc.ts,
  // because it creates a window. Optional root; with none, show the picker.
  registerIpcHandler(
    CHANNELS.WINDOW_OPEN_PROJECT,
    async (event, payload?: { root?: string }): Promise<{ opened: boolean }> => {
      let root = payload?.root ?? null;
      if (!root) {
        const parent = BrowserWindow.fromWebContents(event.sender);
        const r = await (parent
          ? dialog.showOpenDialog(parent, {
              title: mainT('app.openProjectNewWindow'),
              properties: ['openDirectory'],
            })
          : dialog.showOpenDialog({ title: mainT('app.openProjectNewWindow'), properties: ['openDirectory'] }));
        if (r.canceled || r.filePaths.length === 0) return { opened: false };
        root = r.filePaths[0] ?? null;
      }
      if (!root) return { opened: false };
      createWindow(root);
      persistOpenRoots(settingsManager);
      return { opened: true };
    },
  );

  // Welcome is the default startup. When explicitly enabled, restore the
  // windows open at last quit (falling back to v1.0's deprecated lastRoot).
  const roots = projectRootsForStartup(settingsManager.get());
  if (roots.length === 0) createWindow(null);
  else for (const root of roots) createWindow(root);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(projectRootsForStartup(settingsManager.get()).at(-1) ?? null);
    }
  });
});

app.on('window-all-closed', () => {
  // Windows-first app: quit when the last window closes (also on macOS for
  // now — revisit if a macOS build ever matters).
  app.quit();
});

let quitCleanupComplete = false;
let quitCleanupPromise: Promise<void> | null = null;
app.on('before-quit', (event) => {
  // Snapshot the open windows for restore BEFORE tearing them down, then stop
  // the per-window teardown from rewriting openRoots as windows close.
  persistOpenRoots(settingsManager);
  isQuitting = true;
  if (quitCleanupComplete) return;

  event.preventDefault();
  if (quitCleanupPromise) return;
  quitCleanupPromise = Promise.all([
    ...allContexts().map((ctx) => shutdownWindowContext(ctx)),
    ...pendingContextDisposals,
    settingsManager.flush(),
  ])
    .then(() => undefined)
    .catch((err) => logger.warn('main', 'quit cleanup failed', err))
    .finally(() => {
      quitCleanupComplete = true;
      app.quit();
    });
});

// Crash safety. node-pty children (on Windows: the ConPTY conhost + the agent
// CLI) do NOT die with the main process — an abnormal exit orphans them (the
// "后端进程没结束，任务管理器全杀才恢复" symptom). before-quit covers the
// graceful path; these cover the crashes: kill every PTY before the process
// goes down.
let crashCleanupStarted = false;
process.on('uncaughtException', (err) => {
  if (crashCleanupStarted) return;
  crashCleanupStarted = true;
  try {
    logger.error('main', 'uncaughtException — killing all sessions before exit', err);
  } catch {
    // A broken stdout/stderr can be the original exception. Cleanup must still
    // run even when reporting that exception writes to the same broken pipe.
  }
  const hardExit = setTimeout(() => process.exit(1), PROCESS_CRASH_CLEANUP_TIMEOUT_MS);
  void Promise.allSettled(allContexts().map((ctx) => shutdownWindowContext(ctx))).finally(() => {
    clearTimeout(hardExit);
    process.exit(1);
  });
});
process.on('unhandledRejection', (reason) => {
  logger.error(
    'main',
    `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
  for (const ctx of allContexts()) {
    if (ctx.win.isDestroyed()) continue;
    const requestId = `unhandled-${randomUUID()}`;
    ctx.win.webContents.send(EVENTS.SERVICE_HEALTH_CHANGED, {
      domain: 'system',
      state: 'degraded',
      projectScope: ctx.projectScope,
      error: serializeIpcError(
        'service:system',
        reason,
        { requestId },
        randomUUID(),
      ),
    } satisfies ServiceHealthChangedEvent);
  }
});
app.on('child-process-gone', (_e, details) => {
  logger.error('main', `child-process-gone: type=${details.type} reason=${details.reason}`);
});
