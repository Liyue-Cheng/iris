/**
 * @file src/main/build-type.ts
 * @purpose Detect which build artifact this process is — dev / portable /
 *   installed. Ported from Marina's build-type.ts.
 *
 * Detection:
 *   - dev:       !app.isPackaged
 *   - portable:  app.isPackaged && PORTABLE_EXECUTABLE_DIR (injected by the
 *                electron-builder portable wrapper at launch)
 *   - installed: app.isPackaged without the env marker
 *
 * Iris uses this to fork App-owned persistence for dev builds (see
 * settings-manager.appDataDir): `npm run dev` and a packaged exe running on
 * the same machine must not trample each other's settings.json.
 */
import { app } from 'electron';

export type BuildType = 'dev' | 'portable' | 'installed';

let cached: BuildType | null = null;

export function getBuildType(): BuildType {
  if (cached) return cached;
  if (!app.isPackaged) {
    cached = 'dev';
  } else if (process.env['PORTABLE_EXECUTABLE_DIR']) {
    cached = 'portable';
  } else {
    cached = 'installed';
  }
  return cached;
}
