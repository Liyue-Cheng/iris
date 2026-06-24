/**
 * @file src/main/window-context.ts
 * @purpose Per-window project + session ownership (VS Code-style multi-window).
 *   Each BrowserWindow binds one project and owns its own ProjectManager (one
 *   chokidar watcher) and SessionManager (its PTY pool). SettingsManager stays
 *   a single machine-level instance shared across all windows.
 *
 * This module is a pure registry keyed by BrowserWindow.id — no manager
 * construction here (that lives in index.ts, which owns the wiring), so there
 * is no import cycle with ipc.ts. IPC handlers resolve "which window" from
 * `event.sender` via requireContext/contextForWebContents and act on that
 * window's managers; main → renderer broadcasts (wireBroadcasts) are already
 * per-window, so a window only ever sees its own project's events.
 */
import { BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { ProjectManager } from './project-manager';
import type { SessionManager } from './session-manager';
import type { SettingsManager } from './settings-manager';

export interface WindowContext {
  readonly win: BrowserWindow;
  readonly projectManager: ProjectManager;
  readonly sessionManager: SessionManager;
  /** Project bound to this window (null when none open yet). Updated on
   *  project:open so WINDOW_BOOTSTRAP and persistence see the current root. */
  projectRoot: string | null;
  /** Detach this window's manager → renderer broadcasts (from wireBroadcasts). */
  readonly unwire: () => void;
}

const contexts = new Map<number, WindowContext>();

export function registerContext(ctx: WindowContext): void {
  contexts.set(ctx.win.id, ctx);
}

export function contextForWebContents(sender: WebContents): WindowContext | undefined {
  const win = BrowserWindow.fromWebContents(sender);
  return win ? contexts.get(win.id) : undefined;
}

/** Resolve the calling window's context or throw — used by per-window IPC
 *  handlers. A miss means the window was torn down between send and handle;
 *  the handler rejects with a clear message instead of acting on the wrong
 *  (or a stale global) project. */
export function requireContext(event: IpcMainInvokeEvent): WindowContext {
  const ctx = contextForWebContents(event.sender);
  if (!ctx) {
    throw new Error('[ipc] no WindowContext for sender — window gone?');
  }
  return ctx;
}

export function allContexts(): WindowContext[] {
  return [...contexts.values()];
}

/** Remove and return a window's context (caller runs the teardown). */
export function removeContext(id: number): WindowContext | undefined {
  const ctx = contexts.get(id);
  if (ctx) contexts.delete(id);
  return ctx;
}

/**
 * Snapshot every open window's bound project into settings so the next launch
 * restores them (one window per root). De-duped — the same project open in two
 * windows restores as one. Also writes lastRoot (deprecated) for back-compat.
 */
export function persistOpenRoots(settingsManager: SettingsManager): void {
  const roots = [
    ...new Set(allContexts().map((c) => c.projectRoot).filter((r): r is string => !!r)),
  ];
  settingsManager.update({ project: { openRoots: roots, lastRoot: roots.at(-1) ?? null } });
}
