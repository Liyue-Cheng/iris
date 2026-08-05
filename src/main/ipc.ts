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
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CHANNELS, EVENTS } from '@shared/protocol';
import type {
  DeepPartial,
  DocContent,
  FsIrisChangedEvent,
  GitChangedEvent,
  GitSnapshot,
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
import type { GitManager } from './git-manager';
import type { SessionManager } from './session-manager';
import {
  installMachineConventions,
  machineConventionsState,
  readUserConstitutionTemplate,
} from './machine-layer';
import { injectionState, installFocusScript, installHook } from './agent-injection';
import { contextForWebContents, persistOpenRoots, requireContext } from './window-context';
import { effectiveStyleMaps, writeProjectStyleMaps } from './style-maps-store';
import type { StyleMaps, StyleMapsState } from '@shared/style-maps';
import { logger } from './logger';

const execFileP = promisify(execFile);

/** Run a git subcommand in `cwd` with a short timeout; throws on failure. */
function execFileGit(args: string[], cwd: string): Promise<{ stdout: string }> {
  return execFileP('git', args, { cwd, timeout: 3000, windowsHide: true });
}

export function registerIpcHandlers(settingsManager: SettingsManager): void {
  // Per-window handlers (project / session / doc / styles / software-prompt /
  // shell) resolve the calling window's managers from event.sender via
  // requireContext(event). Machine-level handlers (settings / machine / agent
  // install / perf / clipboard / window chrome) stay global below.
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
    async (event, payload: { root: string }): Promise<IrisScanResult> => {
      const ctx = requireContext(event);
      const result = await ctx.projectManager.open(payload.root);
      await ctx.gitManager.open(payload.root);
      // Bind this window to the opened project so WINDOW_BOOTSTRAP and restore
      // persistence see the current root.
      ctx.projectRoot = result.projectRoot;
      // Snapshot all open windows' projects for restore on next launch. Verb
      // side effect, so it lives here in the instruction body, not in some
      // renderer afterthought.
      persistOpenRoots(settingsManager);
      return result;
    },
  );

  ipcMain.handle(CHANNELS.PROJECT_SCAN, (event): Promise<IrisScanResult> =>
    requireContext(event).projectManager.scan(),
  );

  ipcMain.handle(CHANNELS.PROJECT_INIT, async (event) =>
    requireContext(event).projectManager.initIris({
      appVersion: app.getVersion(),
      userConstitution: await readUserConstitutionTemplate(),
    }),
  );

  ipcMain.handle(
    CHANNELS.WORKSPACE_CREATE,
    (event, payload: { parentPath: string; name: string; template: 'standard' | 'empty' }) =>
      requireContext(event).projectManager.createWorkspace(payload),
  );

  // Multi-window: which project THIS window is bound to (renderer asks at boot).
  ipcMain.handle(CHANNELS.WINDOW_BOOTSTRAP, (event): { projectRoot: string | null } => ({
    projectRoot: contextForWebContents(event.sender)?.projectRoot ?? null,
  }));

  ipcMain.handle(CHANNELS.MACHINE_CONVENTIONS_STATE, () => machineConventionsState());

  ipcMain.handle(CHANNELS.MACHINE_INSTALL_CONVENTIONS, () => installMachineConventions());

  // ── context-injection adapter (focus-context script + CLI hooks) ────

  ipcMain.handle(CHANNELS.AGENT_INJECTION_STATE, () => injectionState());

  ipcMain.handle(CHANNELS.AGENT_INSTALL_FOCUS_SCRIPT, () => installFocusScript());

  ipcMain.handle(CHANNELS.AGENT_INSTALL_HOOK, (_event, payload: { cliId: string }) =>
    installHook(payload.cliId),
  );

  // ── prompt governance (issue: iris软件提示词治理) ─────────────────────

  ipcMain.handle(CHANNELS.SOFTWARE_PROMPT_STATE, (event) =>
    requireContext(event).projectManager.softwarePromptState(app.getVersion()),
  );

  ipcMain.handle(CHANNELS.SOFTWARE_PROMPT_PREVIEW, (event) =>
    requireContext(event).projectManager.contextPreview(app.getVersion()),
  );

  ipcMain.handle(CHANNELS.SOFTWARE_PROMPT_SYNC_ENTRY, (event, payload: { path: string }) =>
    requireContext(event).projectManager.syncSoftwareEntry(payload.path, app.getVersion()),
  );

  ipcMain.handle(CHANNELS.SOFTWARE_PROMPT_UPGRADE_CONSTITUTION, (event) =>
    requireContext(event).projectManager.upgradeConstitution(app.getVersion()),
  );

  ipcMain.handle(CHANNELS.SHELL_REVEAL, (event, payload: { path: string }): void => {
    // Relative paths are project-root-relative (doc rows pass them as-is);
    // absolute paths (machine layer) pass through untouched.
    let target = payload.path;
    if (!isAbsolute(target)) {
      const root = requireContext(event).projectManager.getRoot();
      if (!root) return;
      target = join(root, target);
    }
    shell.showItemInFolder(target);
  });

  // ── clipboard (Electron module — bypasses web Permission API) ──────

  ipcMain.handle(CHANNELS.CLIPBOARD_READ_TEXT, (): { text: string } => {
    try {
      return { text: clipboard.readText() };
    } catch {
      return { text: '' };
    }
  });

  ipcMain.handle(
    CHANNELS.CLIPBOARD_WRITE_TEXT,
    (_event, payload: { text: string }): { ok: boolean } => {
      try {
        clipboard.writeText(payload.text);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );

  // ── window chrome (frameless title bar) ────────────────────────────

  const senderWindow = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle(CHANNELS.WINDOW_MINIMIZE, (event): void => {
    senderWindow(event)?.minimize();
  });

  ipcMain.handle(CHANNELS.WINDOW_MAXIMIZE_TOGGLE, (event): void => {
    const win = senderWindow(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.handle(CHANNELS.WINDOW_CLOSE, (event): void => {
    senderWindow(event)?.close();
  });

  ipcMain.handle(
    CHANNELS.WINDOW_IS_MAXIMIZED,
    (event): boolean => senderWindow(event)?.isMaximized() ?? false,
  );

  ipcMain.handle(
    CHANNELS.WINDOW_EDIT_ACTION,
    (event, payload: { action: 'cut' | 'copy' | 'paste' | 'selectAll' }): void => {
      const wc = senderWindow(event)?.webContents;
      if (!wc) return;
      // Whitelist dispatch — never call arbitrary method names off the wire.
      if (payload.action === 'cut') wc.cut();
      else if (payload.action === 'copy') wc.copy();
      else if (payload.action === 'paste') wc.paste();
      else if (payload.action === 'selectAll') wc.selectAll();
    },
  );

  ipcMain.handle(
    CHANNELS.PROJECT_RAW_TREE,
    (event): Promise<RawTreeNode | null> => requireContext(event).projectManager.rawTree(),
  );

  // Status-doc freshness (CONVENTIONS §status: reflects: <sha>). Best-effort
  // read of the project's current HEAD; any failure (not a repo, no git on
  // PATH, no project open) degrades to null and the UI just omits the badge.
  ipcMain.handle(CHANNELS.PROJECT_GIT_HEAD, async (event): Promise<{ head: string | null }> => {
    const root = requireContext(event).projectManager.getRoot();
    if (!root) return { head: null };
    try {
      const { stdout } = await execFileGit(['rev-parse', 'HEAD'], root);
      const head = stdout.trim();
      return { head: head.length > 0 ? head : null };
    } catch {
      return { head: null };
    }
  });

  ipcMain.handle(CHANNELS.GIT_STATUS, (event): Promise<GitSnapshot> =>
    requireContext(event).gitManager.status(),
  );
  ipcMain.handle(CHANNELS.GIT_REFRESH, (event): Promise<GitSnapshot> =>
    requireContext(event).gitManager.status(),
  );
  ipcMain.handle(CHANNELS.GIT_STAGE, async (event, payload: { paths: string[] }): Promise<GitSnapshot> => {
    const git = requireContext(event).gitManager;
    await git.stage(payload.paths);
    return git.status();
  });
  ipcMain.handle(CHANNELS.GIT_UNSTAGE, async (event, payload: { paths: string[] }): Promise<GitSnapshot> => {
    const git = requireContext(event).gitManager;
    await git.unstage(payload.paths);
    return git.status();
  });
  ipcMain.handle(CHANNELS.GIT_COMMIT, async (event, payload: { message: string }): Promise<GitSnapshot> => {
    const git = requireContext(event).gitManager;
    await git.commit(payload.message);
    return git.status();
  });
  ipcMain.handle(CHANNELS.GIT_SWITCH_BRANCH, async (event, payload: { branch: string }): Promise<GitSnapshot> => {
    const git = requireContext(event).gitManager;
    await git.switchBranch(payload.branch);
    return git.status();
  });

  ipcMain.handle(
    CHANNELS.DOC_READ,
    (event, payload: { path: string }): Promise<DocContent> =>
      requireContext(event).projectManager.readDoc(payload.path),
  );

  ipcMain.handle(
    CHANNELS.DOC_WRITE,
    (event, payload: { path: string; content: string }): Promise<{ path: string }> =>
      requireContext(event).projectManager.writeDoc(payload.path, payload.content),
  );

  ipcMain.handle(
    CHANNELS.DOC_CREATE,
    (
      event,
      payload: { workspacePath: string; type: import('@shared/types').DocType; title: string },
    ): Promise<{ path: string }> => requireContext(event).projectManager.createDoc(payload),
  );

  ipcMain.handle(
    CHANNELS.DOC_DELETE,
    (event, payload: { path: string }): Promise<{ path: string }> =>
      requireContext(event).projectManager.deleteDoc(payload.path),
  );

  // ── style maps (status/label badge tables) ─────────────────────────

  ipcMain.handle(
    CHANNELS.STYLES_GET,
    (event): Promise<StyleMapsState> =>
      effectiveStyleMaps(requireContext(event).projectManager.getRoot()),
  );

  ipcMain.handle(
    CHANNELS.STYLES_UPDATE,
    (event, payload: { maps: StyleMaps }): Promise<StyleMapsState> => {
      const root = requireContext(event).projectManager.getRoot();
      if (!root) throw new Error('[styles:update] no project is open');
      return writeProjectStyleMaps(root, payload.maps);
    },
  );

  // ── sessions ───────────────────────────────────────────────────────

  ipcMain.handle(
    CHANNELS.SESSION_OPEN,
    (
      event,
      payload: {
        docPath: string | null;
        workspacePath?: string | null;
        agentId: string;
        cols: number;
        rows: number;
      },
    ): SessionInfo => {
      const ctx = requireContext(event);
      const root = ctx.projectManager.getRoot();
      if (!root) throw new Error('[session:open] no project is open');
      return ctx.sessionManager.createSession({
        docPath: payload.docPath,
        workspacePath: payload.workspacePath ?? null,
        agentId: payload.agentId,
        projectRoot: root,
        cols: payload.cols,
        rows: payload.rows,
      });
    },
  );

  ipcMain.handle(CHANNELS.SESSION_CLOSE, (event, payload: { sessionId: string }): void => {
    requireContext(event).sessionManager.closeSession(payload.sessionId);
  });

  ipcMain.handle(
    CHANNELS.SESSION_REANCHOR,
    (event, payload: { sessionId: string; docPath: string | null }): SessionInfo =>
      requireContext(event).sessionManager.reanchor(payload.sessionId, payload.docPath),
  );

  ipcMain.handle(
    CHANNELS.SESSION_INPUT,
    (event, payload: { sessionId: string; data: string }) =>
      requireContext(event).sessionManager.sendInput(payload.sessionId, payload.data),
  );

  ipcMain.handle(
    CHANNELS.SESSION_RESIZE,
    (event, payload: { sessionId: string; cols: number; rows: number }) =>
      requireContext(event).sessionManager.resize(payload.sessionId, payload.cols, payload.rows),
  );

  ipcMain.handle(
    CHANNELS.DOC_IMAGE_READ,
    (event, payload: { docPath: string; source: string }) =>
      requireContext(event).projectManager.readDocImage(payload.docPath, payload.source),
  );

  ipcMain.handle(CHANNELS.SESSION_LIST, (event): SessionInfo[] =>
    requireContext(event).sessionManager.list(),
  );

  ipcMain.handle(
    CHANNELS.SESSION_SCROLLBACK,
    (event, payload: { sessionId: string; cols: number; rows: number }) =>
      requireContext(event).sessionManager.prepareReplay(
        payload.sessionId,
        payload.cols,
        payload.rows,
      ),
  );

  ipcMain.handle(CHANNELS.DIALOG_PICK_FOLDER, async (event): Promise<string | null> => {
    const parent = senderWindow(event);
    const result = await (parent
      ? dialog.showOpenDialog(parent, { title: '打开项目文件夹', properties: ['openDirectory'] })
      : dialog.showOpenDialog({ title: '打开项目文件夹', properties: ['openDirectory'] }));
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  logger.info('ipc', 'handlers registered');
}

/** Forward manager events to a window. Returns an unsubscribe fn. */
export function wireBroadcasts(
  settingsManager: SettingsManager,
  projectManager: ProjectManager,
  gitManager: GitManager,
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
  const onGitChanged = (): void => send(EVENTS.GIT_CHANGED, { projectRoot: projectManager.getRoot() } satisfies GitChangedEvent);
  const onOutput = (e: SessionOutputPayload): void => send(EVENTS.SESSION_OUTPUT, e);
  const onState = (e: SessionStateChangedPayload): void => send(EVENTS.SESSION_STATE_CHANGED, e);
  const onExited = (e: SessionExitedPayload): void => send(EVENTS.SESSION_EXITED, e);
  const onDestroyed = (e: { sessionId: string }): void => send(EVENTS.SESSION_DESTROYED, e);
  const onMaximize = (): void => send(EVENTS.WINDOW_MAXIMIZED_CHANGED, { maximized: true });
  const onUnmaximize = (): void => send(EVENTS.WINDOW_MAXIMIZED_CHANGED, { maximized: false });

  window.on('maximize', onMaximize);
  window.on('unmaximize', onUnmaximize);
  settingsManager.on('settingsChanged', onSettings);
  projectManager.on('irisChanged', onIrisChanged);
  gitManager.on('changed', onGitChanged);
  sessionManager.on('sessionOutput', onOutput);
  sessionManager.on('sessionStateChanged', onState);
  sessionManager.on('sessionExited', onExited);
  sessionManager.on('sessionDestroyed', onDestroyed);
  return () => {
    window.off('maximize', onMaximize);
    window.off('unmaximize', onUnmaximize);
    settingsManager.off('settingsChanged', onSettings);
    projectManager.off('irisChanged', onIrisChanged);
    gitManager.off('changed', onGitChanged);
    sessionManager.off('sessionOutput', onOutput);
    sessionManager.off('sessionStateChanged', onState);
    sessionManager.off('sessionExited', onExited);
    sessionManager.off('sessionDestroyed', onDestroyed);
  };
}
