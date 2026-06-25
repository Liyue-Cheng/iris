/**
 * @file src/main/index.ts
 * @purpose Electron main-process entry — a featherweight single-instance gate.
 *
 * This module imports ONLY `electron`. The real app (settings, windows, IPC,
 * and the externalized native backend node-pty / @xterm / chokidar) lives in
 * ./app-main and is loaded lazily, only by the instance that wins the lock.
 *
 * Why the split (issue 2026-06-23-多窗口多项目): in a portable build every
 * launch extracts the app to a fresh %TEMP%\<random>\ that the portable wrapper
 * deletes when the process exits. A second launch loses the single-instance
 * lock and must die. If this entry statically imported the native backend (as
 * it used to), the loser would first resolve node-pty/@xterm/chokidar by reading
 * their package.json out of its temp dir, then exit(0); the wrapper deleting
 * that temp dir would race an in-flight ESM `package.json` read and crash the
 * loser with `ENOENT … Temp\<random>\…\package.json`. Keeping the loser down to
 * just `electron` means it resolves none of that — it forwards its argv via
 * requestSingleInstanceLock (which fires the winner's `second-instance` → new
 * window, VS Code-style) and exits cleanly.
 */
import { app } from 'electron';
import { logger } from './logger';

// smoke-launch.mjs pattern-matches this line as the bootstrap milestone.
console.log('[main] bootstrap starting');
logger.info('boot', `bootstrap starting pid=${process.pid} argv=${JSON.stringify(process.argv)}`);

// Dev/installed isolation (issue 2026-06-25-开发版与安装版实例隔离): a dev run
// (electron-vite sets ELECTRON_RENDERER_URL) gets its OWN userData profile so its
// single-instance lock is keyed on a dev-only path. This MUST run before
// requestSingleInstanceLock() below — the lock is derived from the userData dir,
// so setting it later (as app-main.ts used to) leaves dev and the installed build
// sharing one lock: `npm run dev` while the installed app is open then loses the
// lock and forwards its argv to the installed instance instead of opening a dev
// window. Kept in this featherweight entry (electron-only) on purpose.
if (process.env.ELECTRON_RENDERER_URL) {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

if (!app.requestSingleInstanceLock()) {
  // Lost the lock — another instance owns this profile. The call above already
  // forwarded our argv to it (firing its `second-instance` handler, which opens
  // the new window). Exit synchronously, here and now, before importing the
  // native backend: nothing heavy was loaded, so there is no package.json
  // resolution left to race the portable temp-dir cleanup.
  console.log('[main] another instance holds the lock — exiting');
  logger.info('boot', `lost single-instance lock — forwarded argv, exiting pid=${process.pid}`);
  app.exit(0);
} else {
  // Winner: load and run the real main process. The dynamic import makes rollup
  // emit ./app-main as its own chunk, so the loser branch never touches it.
  logger.info('boot', `won single-instance lock — loading app-main pid=${process.pid}`);
  void import('./app-main.js');
}
