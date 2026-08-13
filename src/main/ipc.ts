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
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain as electronIpcMain,
  shell,
} from 'electron';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CHANNELS, EVENTS, type WindowEditAction } from '@shared/protocol';
import { mainT } from './i18n';
import type {
  AssetImportPayload,
  AssetImportResult,
  AssetInventory,
  AppExternalLinkId,
  AppInfo,
  AppLegalDocumentId,
  DeepPartial,
  DocContent,
  FsIrisChangedEvent,
  GitChangedEvent,
  GitSnapshot,
  IrisAgentListSnapshot,
  IrisAgentSessionChangedPayload,
  IrisAgentSessionDestroyedPayload,
  IrisAgentSessionInfo,
  IrisScanResult,
  PingResult,
  ProjectOpenResult,
  ProjectPromptUpdateResult,
  ProjectCommandRunResult,
  ProjectSettingsSnapshot,
  ProjectScope,
  ProjectToolbarAction,
  RawTreeNode,
  RecentProject,
  SessionExitedPayload,
  SessionDestroyedPayload,
  SessionInfo,
  SessionListSnapshot,
  SessionOutputPayload,
  SessionStateChangedPayload,
  Settings,
  SettingsChangedEvent,
  WindowBootstrapState,
} from '@shared/types';
import type { SettingsManager } from './settings-manager';
import type { ProjectManager } from './project-manager';
import type { GitManager } from './git-manager';
import type { SessionManager } from './session-manager';
import type { IrisAgentSessionManager } from './agent/session-manager';
import {
  detachTerminalOutput,
  shouldForwardTerminalOutput,
  type TerminalOutputAttachment,
} from './terminal/output-attachment';
import { injectionState, installFocusScript, installHook, removeHook } from './agent-injection';
import {
  contextForWebContents,
  persistOpenRoots,
  requireContext,
  type WindowContext,
} from './window-context';
import { logger } from './logger';
import { enqueueProjectSwitch } from './project-switch';
import { launchSystemTerminal } from './system-terminal';
import {
  buildAppInfo,
  externalLink,
  externalUrl,
  legalDocumentPath,
  readProductManifest,
} from './app-info';
import { getBuildType } from './build-type';
import type {
  HealthDomain,
  IpcRequest,
  IpcRequestMeta,
  IpcResult,
  ServiceHealthChangedEvent,
} from '@shared/app-error';
import { serializeIpcError } from './ipc-error';

const execFileP = promisify(execFile);

type RawIpcHandler = (
  event: Electron.IpcMainInvokeEvent,
  ...args: any[]
) => any;

function isRequestEnvelope(value: unknown): value is IpcRequest<unknown> {
  if (!value || typeof value !== 'object') return false;
  const meta = (value as { meta?: unknown }).meta;
  return Boolean(
    meta &&
      typeof meta === 'object' &&
      typeof (meta as { requestId?: unknown }).requestId === 'string',
  );
}

export function registerIpcHandler(channel: string, handler: RawIpcHandler): void {
  electronIpcMain.handle(channel, async (event, rawRequest: unknown): Promise<IpcResult<unknown>> => {
    const request = isRequestEnvelope(rawRequest)
      ? rawRequest
      : {
          meta: { requestId: randomUUID() } satisfies IpcRequestMeta,
          payload: rawRequest,
        };
    try {
      const value: unknown = await handler(event, request.payload);
      return { ok: true, value };
    } catch (error) {
      const serialized = serializeIpcError(channel, error, request.meta, randomUUID());
      logger.error(
        'ipc',
        `${channel} failed request=${serialized.requestId} incident=${serialized.incidentId}` +
          (serialized.correlationId ? ` correlation=${serialized.correlationId}` : ''),
        error,
      );
      return { ok: false, error: serialized };
    }
  });
}

// Keep the registration call sites compact while ensuring every channel uses
// the same serialization and logging boundary.
const ipcMain = { handle: registerIpcHandler };

type ProjectScopedPayload = { expectedScope: ProjectScope | null };

function sameScope(a: ProjectScope | null, b: ProjectScope | null): boolean {
  return a?.root === b?.root && a?.generation === b?.generation;
}

/** Main is the authorization boundary; CPU locks are ordering, not trust. */
function requireProjectScope(
  ctx: WindowContext,
  payload: ProjectScopedPayload,
  channel: string,
): ProjectScope {
  if (ctx.projectSwitching) throw new Error(`[${channel}] project switch in progress`);
  if (!sameScope(payload.expectedScope, ctx.projectScope)) {
    throw new Error(`[${channel}] stale project scope`);
  }
  const scope = ctx.projectScope;
  if (!scope || ctx.projectManager.getRoot() !== scope.root) {
    throw new Error(`[${channel}] no committed project is open`);
  }
  return scope;
}

function resolveProjectItemPath(scope: ProjectScope, itemPath: string, channel: string): string {
  if (!itemPath || isAbsolute(itemPath)) {
    throw new Error(`[${channel}] path must be project-relative`);
  }
  const target = resolve(scope.root, itemPath);
  const rel = relative(scope.root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`[${channel}] path is outside the active project`);
  }
  return target;
}

function sessionsForScope(ctx: WindowContext, scope: ProjectScope): SessionInfo[] {
  return ctx.sessionManager
    .list()
    .filter(
      (session) =>
        session.projectRoot === scope.root &&
        session.projectGeneration === scope.generation,
    );
}

function requireSessionInScope(
  ctx: WindowContext,
  sessionId: string,
  scope: ProjectScope,
  channel: string,
): SessionInfo {
  const session = ctx.sessionManager.get(sessionId);
  if (
    !session ||
    session.projectRoot !== scope.root ||
    session.projectGeneration !== scope.generation
  ) {
    throw new Error(`[${channel}] session is outside the active project scope`);
  }
  return session;
}

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

  const currentAppInfo = (): AppInfo =>
    buildAppInfo(
      {
        version: app.getVersion(),
        buildType: getBuildType(),
        platform: process.platform,
        arch: process.arch,
        electronVersion: process.versions.electron ?? '',
        chromiumVersion: process.versions.chrome ?? '',
        nodeVersion: process.versions.node,
        userDataPath: app.getPath('userData'),
      },
      readProductManifest(app.getAppPath()),
    );

  ipcMain.handle(CHANNELS.APP_INFO, (): AppInfo => currentAppInfo());

  ipcMain.handle(
    CHANNELS.APP_OPEN_LEGAL_DOCUMENT,
    async (_event, payload: { id: AppLegalDocumentId }): Promise<void> => {
      const target = legalDocumentPath(
        {
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
          packaged: app.isPackaged,
        },
        payload?.id,
      );
      const metadata = await stat(target).catch(() => null);
      if (!metadata?.isFile()) {
        throw new Error(`[${CHANNELS.APP_OPEN_LEGAL_DOCUMENT}] document is unavailable`);
      }
      const error = await shell.openPath(target);
      if (error) throw new Error(`[${CHANNELS.APP_OPEN_LEGAL_DOCUMENT}] ${error}`);
    },
  );

  ipcMain.handle(
    CHANNELS.APP_OPEN_EXTERNAL_LINK,
    async (_event, payload: { id: AppExternalLinkId }): Promise<void> => {
      await shell.openExternal(externalLink(currentAppInfo(), payload?.id));
    },
  );

  ipcMain.handle(CHANNELS.APP_REVEAL_USER_DATA, async (): Promise<void> => {
    const error = await shell.openPath(app.getPath('userData'));
    if (error) throw new Error(`[${CHANNELS.APP_REVEAL_USER_DATA}] ${error}`);
  });

  ipcMain.handle(CHANNELS.SETTINGS_GET, (): Settings => settingsManager.get());

  ipcMain.handle(
    CHANNELS.SETTINGS_UPDATE,
    (_event, partial: DeepPartial<Settings>): Settings => {
      settingsManager.update(partial);
      return settingsManager.get();
    },
  );

  const withProjectTrust = (
    scope: ProjectScope,
    snapshot: Awaited<ReturnType<ProjectManager['projectSettings']>>,
  ): ProjectSettingsSnapshot => ({
    ...snapshot,
    trusted: settingsManager.get().project.commandTrust[scope.root] === snapshot.revision,
  });

  // ── project ────────────────────────────────────────────────────────

  ipcMain.handle(
    CHANNELS.PROJECT_OPEN,
    (event, payload: { root: string } & ProjectScopedPayload): Promise<ProjectOpenResult> => {
      const ctx = requireContext(event);
      return enqueueProjectSwitch(
        ctx,
        payload,
        (scope) => {
          settingsManager.recordRecentProject(scope.root);
          persistOpenRoots(settingsManager);
        },
        async (scope) => withProjectTrust(scope, await ctx.projectManager.projectSettings()),
      );
    },
  );

  ipcMain.handle(CHANNELS.PROJECT_RECENT_LIST, async (): Promise<RecentProject[]> => {
    const roots = settingsManager.get().project.recentRoots;
    return Promise.all(
      roots.map(async (path): Promise<RecentProject> => {
        let exists = false;
        try {
          exists = (await stat(path)).isDirectory();
        } catch {
          // Keep stale history visible so the user can understand and remove it.
        }
        return { path, name: basename(path) || path, exists };
      }),
    );
  });

  ipcMain.handle(
    CHANNELS.PROJECT_RECENT_REMOVE,
    (_event, payload: { path: string }): { removed: true } => {
      if (!payload || typeof payload.path !== 'string' || payload.path.trim() === '') {
        throw new Error('[project:recent-remove] path must be a non-empty string');
      }
      settingsManager.removeRecentProject(payload.path);
      return { removed: true };
    },
  );

  ipcMain.handle(
    CHANNELS.PROJECT_SCAN,
    (event, payload: ProjectScopedPayload): Promise<IrisScanResult> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.PROJECT_SCAN);
      return ctx.projectManager.scan();
    },
  );

  ipcMain.handle(CHANNELS.PROJECT_INIT, async (event, payload: ProjectScopedPayload) => {
    const ctx = requireContext(event);
    requireProjectScope(ctx, payload, CHANNELS.PROJECT_INIT);
    return ctx.projectManager.initIris();
  });

  ipcMain.handle(
    CHANNELS.WORKSPACE_CREATE,
    (
      event,
      payload: {
        parentPath: string;
        name: string;
        template: 'standard' | 'empty';
      } & ProjectScopedPayload,
    ) => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.WORKSPACE_CREATE);
      return ctx.projectManager.createWorkspace(payload);
    },
  );

  // Multi-window: which project THIS window is bound to (renderer asks at boot).
  ipcMain.handle(CHANNELS.WINDOW_BOOTSTRAP, (event): WindowBootstrapState => {
    const ctx = contextForWebContents(event.sender);
    return {
      requestedRoot: ctx?.projectRoot ?? null,
      activeScope: ctx?.projectScope ?? null,
    };
  });

  // ── context-injection adapter (focus-context script + CLI hooks) ────

  ipcMain.handle(CHANNELS.AGENT_INJECTION_STATE, () => injectionState());

  ipcMain.handle(CHANNELS.AGENT_INSTALL_FOCUS_SCRIPT, () => installFocusScript());

  ipcMain.handle(CHANNELS.AGENT_INSTALL_HOOK, (_event, payload: { cliId: string }) =>
    installHook(payload.cliId),
  );

  ipcMain.handle(CHANNELS.AGENT_REMOVE_HOOK, (_event, payload: { cliId: string }) =>
    removeHook(payload.cliId),
  );

  // ── prompt governance (issue: iris软件提示词治理) ─────────────────────

  ipcMain.handle(CHANNELS.SOFTWARE_PROMPT_STATE, (event, payload: ProjectScopedPayload) => {
    const ctx = requireContext(event);
    requireProjectScope(ctx, payload, CHANNELS.SOFTWARE_PROMPT_STATE);
    return ctx.projectManager.softwarePromptState();
  });

  ipcMain.handle(CHANNELS.SOFTWARE_PROMPT_PREVIEW, (event, payload: ProjectScopedPayload) => {
    const ctx = requireContext(event);
    requireProjectScope(ctx, payload, CHANNELS.SOFTWARE_PROMPT_PREVIEW);
    return ctx.projectManager.contextPreview();
  });

  ipcMain.handle(
    CHANNELS.SOFTWARE_PROMPT_SYNC_ENTRY,
    (event, payload: { path: string } & ProjectScopedPayload) => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.SOFTWARE_PROMPT_SYNC_ENTRY);
      return ctx.projectManager.syncSoftwareEntry(payload.path);
    },
  );

  ipcMain.handle(CHANNELS.PROMPT_SYNC_ALL, (event, payload: ProjectScopedPayload) => {
    const ctx = requireContext(event);
    requireProjectScope(ctx, payload, CHANNELS.PROMPT_SYNC_ALL);
    return ctx.projectManager.syncAllPromptEntries();
  });

  ipcMain.handle(
    CHANNELS.PROMPT_ENTRY_ADD,
    async (
      event,
      payload: { path: string; expectedRevision: string } & ProjectScopedPayload,
    ): Promise<ProjectPromptUpdateResult> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.PROMPT_ENTRY_ADD);
      const result = await ctx.projectManager.addPromptEntry(payload.path, payload.expectedRevision);
      return { ...result, snapshot: withProjectTrust(scope, result.snapshot) };
    },
  );

  ipcMain.handle(
    CHANNELS.PROMPT_ENTRY_REMOVE,
    async (
      event,
      payload: { path: string; expectedRevision: string } & ProjectScopedPayload,
    ): Promise<ProjectPromptUpdateResult> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.PROMPT_ENTRY_REMOVE);
      const result = await ctx.projectManager.removePromptEntry(payload.path, payload.expectedRevision);
      return { ...result, snapshot: withProjectTrust(scope, result.snapshot) };
    },
  );

  ipcMain.handle(
    CHANNELS.PROJECT_PROMPT_SYNC,
    async (
      event,
      payload: { text: string; expectedRevision: string } & ProjectScopedPayload,
    ): Promise<ProjectPromptUpdateResult> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.PROJECT_PROMPT_SYNC);
      const result = await ctx.projectManager.syncProjectPrompt(
        payload.text,
        payload.expectedRevision,
      );
      return { ...result, snapshot: withProjectTrust(scope, result.snapshot) };
    },
  );

  ipcMain.handle(
    CHANNELS.PROJECT_PROMPT_RESTORE_ENTRY,
    (event, payload: { path: string } & ProjectScopedPayload) => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.PROJECT_PROMPT_RESTORE_ENTRY);
      return ctx.projectManager.restoreProjectPromptEntry(payload.path);
    },
  );

  ipcMain.handle(
    CHANNELS.PROJECT_SETTINGS_GET,
    async (event, payload: ProjectScopedPayload): Promise<ProjectSettingsSnapshot> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.PROJECT_SETTINGS_GET);
      return withProjectTrust(scope, await ctx.projectManager.projectSettings());
    },
  );

  ipcMain.handle(
    CHANNELS.PROJECT_SETTINGS_UPDATE_TOOLBAR,
    async (
      event,
      payload: {
        actions: ProjectToolbarAction[];
        expectedRevision: string;
      } & ProjectScopedPayload,
    ): Promise<ProjectSettingsSnapshot> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.PROJECT_SETTINGS_UPDATE_TOOLBAR);
      const snapshot = await ctx.projectManager.updateProjectToolbar(
        payload.actions,
        payload.expectedRevision,
      );
      return withProjectTrust(scope, snapshot);
    },
  );

  ipcMain.handle(
    CHANNELS.PROJECT_COMMAND_RUN,
    async (
      event,
      payload: {
        actionIndex: number;
        revision: string;
        approveRevision?: string;
        cols: number;
        rows: number;
      } & ProjectScopedPayload,
    ): Promise<ProjectCommandRunResult> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.PROJECT_COMMAND_RUN);
      if (!Number.isInteger(payload.actionIndex) || payload.actionIndex < 0) {
        throw new Error(`[${CHANNELS.PROJECT_COMMAND_RUN}] invalid action index`);
      }
      const snapshot = await ctx.projectManager.projectSettings();
      if (snapshot.error) throw new Error(`[${CHANNELS.PROJECT_COMMAND_RUN}] ${snapshot.error}`);
      if (snapshot.revision !== payload.revision) {
        throw new Error(`[${CHANNELS.PROJECT_COMMAND_RUN}] stale project settings revision`);
      }
      const action = snapshot.settings.toolbar.actions[payload.actionIndex];
      if (!action) throw new Error(`[${CHANNELS.PROJECT_COMMAND_RUN}] action not found`);

      const trustedRevision = settingsManager.get().project.commandTrust[scope.root];
      if (trustedRevision !== snapshot.revision) {
        if (payload.approveRevision !== snapshot.revision) {
          throw new Error(`[${CHANNELS.PROJECT_COMMAND_RUN}] project command trust required`);
        }
        settingsManager.trustProjectCommands(scope.root, snapshot.revision);
      }

      if (action.terminal === 'iris') {
        const session = ctx.sessionManager.createCommandSession({
          actionIndex: payload.actionIndex,
          description: action.description,
          command: action.command,
          projectRoot: scope.root,
          projectGeneration: scope.generation,
          cols: payload.cols,
          rows: payload.rows,
        });
        return { kind: 'iris', session };
      }
      const pid = await launchSystemTerminal(action.command, scope.root);
      return { kind: 'system', pid };
    },
  );

  ipcMain.handle(CHANNELS.SHELL_REVEAL, (event, payload: { path: string }): void => {
    // Relative paths are project-root-relative (doc rows pass them as-is);
    // absolute paths (machine layer) pass through untouched.
    let target = payload.path;
    if (!isAbsolute(target)) {
      const scope = requireProjectScope(
        requireContext(event),
        payload as typeof payload & ProjectScopedPayload,
        CHANNELS.SHELL_REVEAL,
      );
      target = resolveProjectItemPath(scope, target, CHANNELS.SHELL_REVEAL);
    }
    shell.showItemInFolder(target);
  });

  ipcMain.handle(
    CHANNELS.SHELL_OPEN_PATH,
    async (event, payload: { path: string } & ProjectScopedPayload): Promise<void> => {
      const scope = requireProjectScope(
        requireContext(event),
        payload,
        CHANNELS.SHELL_OPEN_PATH,
      );
      const target = resolveProjectItemPath(scope, payload.path, CHANNELS.SHELL_OPEN_PATH);
      const error = await shell.openPath(target);
      if (error) throw new Error(`[${CHANNELS.SHELL_OPEN_PATH}] ${error}`);
    },
  );

  ipcMain.handle(
    CHANNELS.SHELL_OPEN_EXTERNAL_URL,
    async (_event, payload: { url: string }): Promise<void> => {
      await shell.openExternal(externalUrl(payload?.url));
    },
  );

  // ── clipboard (Electron module — bypasses web Permission API) ──────

  ipcMain.handle(CHANNELS.CLIPBOARD_READ_TEXT, (): { text: string } => {
    return { text: clipboard.readText() };
  });

  ipcMain.handle(
    CHANNELS.CLIPBOARD_WRITE_TEXT,
    (_event, payload: { text: string }): { ok: boolean } => {
      clipboard.writeText(payload.text);
      return { ok: true };
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
    (event, payload: { action: WindowEditAction }): void => {
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
    (event, payload: ProjectScopedPayload): Promise<RawTreeNode | null> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.PROJECT_RAW_TREE);
      return ctx.projectManager.rawTree();
    },
  );

  // Status-doc freshness (software prompt: reflects: <sha>). Best-effort
  // read of the project's current HEAD; any failure (not a repo, no git on
  // PATH, no project open) degrades to null and the UI just omits the badge.
  ipcMain.handle(CHANNELS.PROJECT_GIT_HEAD, async (event, payload: ProjectScopedPayload): Promise<{ head: string | null }> => {
    const ctx = requireContext(event);
    const root = requireProjectScope(ctx, payload, CHANNELS.PROJECT_GIT_HEAD).root;
    try {
      const { stdout } = await execFileGit(['rev-parse', 'HEAD'], root);
      const head = stdout.trim();
      return { head: head.length > 0 ? head : null };
    } catch {
      return { head: null };
    }
  });

  ipcMain.handle(
    CHANNELS.GIT_STATUS,
    (event, payload: ProjectScopedPayload): Promise<GitSnapshot> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.GIT_STATUS);
      return ctx.gitManager.status();
    },
  );
  ipcMain.handle(
    CHANNELS.GIT_REFRESH,
    (event, payload: ProjectScopedPayload): Promise<GitSnapshot> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.GIT_REFRESH);
      return ctx.gitManager.status();
    },
  );
  ipcMain.handle(CHANNELS.GIT_STAGE, async (event, payload: { paths: string[] } & ProjectScopedPayload): Promise<GitSnapshot> => {
    const ctx = requireContext(event);
    requireProjectScope(ctx, payload, CHANNELS.GIT_STAGE);
    const git = ctx.gitManager;
    await git.stage(payload.paths);
    return git.status();
  });
  ipcMain.handle(CHANNELS.GIT_UNSTAGE, async (event, payload: { paths: string[] } & ProjectScopedPayload): Promise<GitSnapshot> => {
    const ctx = requireContext(event);
    requireProjectScope(ctx, payload, CHANNELS.GIT_UNSTAGE);
    const git = ctx.gitManager;
    await git.unstage(payload.paths);
    return git.status();
  });
  ipcMain.handle(CHANNELS.GIT_COMMIT, async (event, payload: { message: string } & ProjectScopedPayload): Promise<GitSnapshot> => {
    const ctx = requireContext(event);
    requireProjectScope(ctx, payload, CHANNELS.GIT_COMMIT);
    const git = ctx.gitManager;
    await git.commit(payload.message);
    return git.status();
  });
  ipcMain.handle(CHANNELS.GIT_SWITCH_BRANCH, async (event, payload: { branch: string } & ProjectScopedPayload): Promise<GitSnapshot> => {
    const ctx = requireContext(event);
    requireProjectScope(ctx, payload, CHANNELS.GIT_SWITCH_BRANCH);
    const git = ctx.gitManager;
    await git.switchBranch(payload.branch);
    return git.status();
  });

  ipcMain.handle(
    CHANNELS.DOC_READ,
    (event, payload: { path: string } & ProjectScopedPayload): Promise<DocContent> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.DOC_READ);
      return ctx.projectManager.readDoc(payload.path);
    },
  );

  ipcMain.handle(
    CHANNELS.DOC_WRITE,
    (
      event,
      payload: {
        path: string;
        content: string;
        expectedContent: string | null;
      } & ProjectScopedPayload,
    ): Promise<{ path: string }> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.DOC_WRITE);
      return ctx.projectManager.writeDoc(payload.path, payload.content, payload.expectedContent);
    },
  );

  ipcMain.handle(
    CHANNELS.DOC_CREATE,
    (
      event,
      payload: {
        workspacePath: string;
        type: import('@shared/types').DocType;
        title: string;
      } & ProjectScopedPayload,
    ): Promise<{ path: string }> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.DOC_CREATE);
      return ctx.projectManager.createDoc(payload);
    },
  );

  ipcMain.handle(
    CHANNELS.DOC_DELETE,
    (
      event,
      payload: { path: string } & ProjectScopedPayload,
    ): Promise<{ path: string; assetCount: number }> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.DOC_DELETE);
      return ctx.projectManager.deleteDoc(payload.path, (path) => shell.trashItem(path));
    },
  );

  ipcMain.handle(
    CHANNELS.ASSET_LIST,
    (event, payload: { docPath: string } & ProjectScopedPayload): Promise<AssetInventory> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.ASSET_LIST);
      return ctx.projectManager.listAssets(payload.docPath);
    },
  );

  ipcMain.handle(
    CHANNELS.ASSET_IMPORT,
    (event, payload: AssetImportPayload & ProjectScopedPayload): Promise<AssetImportResult> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.ASSET_IMPORT);
      return ctx.projectManager.importAsset(payload);
    },
  );

  ipcMain.handle(
    CHANNELS.ASSET_ADOPT,
    (
      event,
      payload: { docPath: string; source: string } & ProjectScopedPayload,
    ): Promise<AssetImportResult> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.ASSET_ADOPT);
      return ctx.projectManager.adoptAsset(payload.docPath, payload.source);
    },
  );

  ipcMain.handle(
    CHANNELS.ASSET_TRASH,
    (
      event,
      payload: { docPath: string; assetPath: string } & ProjectScopedPayload,
    ): Promise<{ path: string }> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.ASSET_TRASH);
      return ctx.projectManager.trashAsset(
        payload.docPath,
        payload.assetPath,
        (path) => shell.trashItem(path),
      );
    },
  );

  // ── sessions ───────────────────────────────────────────────────────

  ipcMain.handle(
    CHANNELS.SESSION_OPEN,
    async (
      event,
      payload: {
        docPath: string | null;
        workspacePath?: string | null;
        agentId: string;
        cols: number;
        rows: number;
      } & ProjectScopedPayload,
    ): Promise<SessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.SESSION_OPEN);
      await ctx.projectManager.assertProjectSettingsReady();
      return ctx.sessionManager.createSession({
        docPath: payload.docPath,
        workspacePath: payload.workspacePath ?? null,
        agentId: payload.agentId,
        projectRoot: scope.root,
        projectGeneration: scope.generation,
        cols: payload.cols,
        rows: payload.rows,
      });
    },
  );

  ipcMain.handle(
    CHANNELS.SESSION_CLOSE,
    (event, payload: { sessionId: string } & ProjectScopedPayload): Promise<void> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.SESSION_CLOSE);
      requireSessionInScope(ctx, payload.sessionId, scope, CHANNELS.SESSION_CLOSE);
      return ctx.sessionManager.closeSession(payload.sessionId);
    },
  );

  ipcMain.handle(
    CHANNELS.SESSION_REANCHOR,
    (
      event,
      payload: { sessionId: string; docPath: string | null } & ProjectScopedPayload,
    ): SessionInfo => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.SESSION_REANCHOR);
      requireSessionInScope(ctx, payload.sessionId, scope, CHANNELS.SESSION_REANCHOR);
      return ctx.sessionManager.reanchor(payload.sessionId, payload.docPath);
    },
  );

  ipcMain.handle(
    CHANNELS.SESSION_INPUT,
    (event, payload: { sessionId: string; data: string } & ProjectScopedPayload) => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.SESSION_INPUT);
      requireSessionInScope(ctx, payload.sessionId, scope, CHANNELS.SESSION_INPUT);
      return ctx.sessionManager.sendInput(payload.sessionId, payload.data);
    },
  );

  ipcMain.handle(
    CHANNELS.SESSION_RESIZE,
    (
      event,
      payload: { sessionId: string; cols: number; rows: number } & ProjectScopedPayload,
    ) => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.SESSION_RESIZE);
      requireSessionInScope(ctx, payload.sessionId, scope, CHANNELS.SESSION_RESIZE);
      return ctx.sessionManager.resize(payload.sessionId, payload.cols, payload.rows);
    },
  );

  ipcMain.handle(
    CHANNELS.SESSION_OUTPUT_ATTACH,
    (
      event,
      payload: { sessionId: string; attachmentId: string } & ProjectScopedPayload,
    ) => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.SESSION_OUTPUT_ATTACH);
      requireSessionInScope(ctx, payload.sessionId, scope, CHANNELS.SESSION_OUTPUT_ATTACH);
      if (ctx.outputAttachment) {
        ctx.sessionManager.detachOutput(ctx.outputAttachment.attachmentId);
      }
      ctx.sessionManager.attachOutput(payload.sessionId, payload.attachmentId);
      ctx.outputAttachment = {
        sessionId: payload.sessionId,
        attachmentId: payload.attachmentId,
        scope,
      };
    },
  );

  ipcMain.handle(
    CHANNELS.SESSION_OUTPUT_DETACH,
    (event, payload: { attachmentId: string }) => {
      const ctx = requireContext(event);
      ctx.sessionManager.detachOutput(payload.attachmentId);
      ctx.outputAttachment = detachTerminalOutput(ctx.outputAttachment, payload.attachmentId);
    },
  );

  ipcMain.handle(
    CHANNELS.SESSION_OUTPUT_ACK,
    (
      event,
      payload: {
        sessionId: string;
        attachmentId: string;
        seq: number;
      } & ProjectScopedPayload,
    ) => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.SESSION_OUTPUT_ACK);
      requireSessionInScope(ctx, payload.sessionId, scope, CHANNELS.SESSION_OUTPUT_ACK);
      ctx.sessionManager.acknowledgeOutput(
        payload.sessionId,
        payload.attachmentId,
        payload.seq,
      );
    },
  );

  ipcMain.handle(
    CHANNELS.DOC_IMAGE_READ,
    (event, payload: { docPath: string; source: string } & ProjectScopedPayload) => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.DOC_IMAGE_READ);
      return ctx.projectManager.readDocImage(payload.docPath, payload.source);
    },
  );

  ipcMain.handle(
    CHANNELS.SESSION_LIST,
    (event, payload: ProjectScopedPayload): SessionListSnapshot => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.SESSION_LIST);
      return { scope, sessions: sessionsForScope(ctx, scope) };
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_OPEN,
    (
      event,
      payload: {
        anchor: { kind: 'document'; path: string } | { kind: 'workspace'; path: string };
      } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_OPEN);
      return ctx.agentSessionManager.createSession({ anchor: payload.anchor, scope });
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_SEND,
    (
      event,
      payload: { sessionId: string; message: string } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_SEND);
      return ctx.agentSessionManager.send(scope, payload.sessionId, payload.message);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_STOP,
    (
      event,
      payload: { sessionId: string } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_STOP);
      return ctx.agentSessionManager.stop(scope, payload.sessionId);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_RETRY,
    (
      event,
      payload: { sessionId: string } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_RETRY);
      return ctx.agentSessionManager.retry(scope, payload.sessionId);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_REWIND,
    (
      event,
      payload: { sessionId: string; turnId: string } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_REWIND);
      return ctx.agentSessionManager.rewind(scope, payload.sessionId, payload.turnId);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_CLOSE,
    (
      event,
      payload: { sessionId: string } & ProjectScopedPayload,
    ): Promise<void> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_CLOSE);
      return ctx.agentSessionManager.closeSession(scope, payload.sessionId);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_LIST,
    (event, payload: ProjectScopedPayload): Promise<IrisAgentListSnapshot> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_LIST);
      return ctx.agentSessionManager.list(scope);
    },
  );

  ipcMain.handle(
    CHANNELS.SESSION_SCROLLBACK,
    (
      event,
      payload: { sessionId: string; cols: number; rows: number } & ProjectScopedPayload,
    ) => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.SESSION_SCROLLBACK);
      requireSessionInScope(ctx, payload.sessionId, scope, CHANNELS.SESSION_SCROLLBACK);
      return ctx.sessionManager.prepareReplay(
        payload.sessionId,
        payload.cols,
        payload.rows,
      );
    },
  );

  ipcMain.handle(CHANNELS.DIALOG_PICK_FOLDER, async (event): Promise<string | null> => {
    const parent = senderWindow(event);
    const result = await (parent
      ? dialog.showOpenDialog(parent, { title: mainT('app.openProject'), properties: ['openDirectory'] })
      : dialog.showOpenDialog({ title: mainT('app.openProject'), properties: ['openDirectory'] }));
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
  agentSessionManager: IrisAgentSessionManager,
  getProjectScope: () => ProjectScope | null,
  getOutputAttachment: () => TerminalOutputAttachment | null,
  window: BrowserWindow,
): () => void {
  type RawHealthChange = {
    domain: HealthDomain;
    state: 'healthy' | 'degraded';
    error?: unknown;
  };
  const send = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  };
  const onSettings = (e: SettingsChangedEvent): void => send(EVENTS.SETTINGS_CHANGED, e);
  const onIrisChanged = (e: FsIrisChangedEvent): void => {
    const scope = getProjectScope();
    if (!scope || scope.root !== e.projectRoot) return;
    send(EVENTS.FS_IRIS_CHANGED, { ...e, projectGeneration: scope.generation });
  };
  const onPromptChanged = (): void => send(EVENTS.PROMPT_CHANGED, undefined);
  const onGitChanged = (): void =>
    send(EVENTS.GIT_CHANGED, { projectScope: getProjectScope() } satisfies GitChangedEvent);
  const onHealthChanged = (event: RawHealthChange): void => {
    const projectScope = getProjectScope();
    const payload: ServiceHealthChangedEvent = {
      domain: event.domain,
      state: event.state,
      projectScope,
    };
    if (event.error !== undefined) {
      const requestId = `service-${randomUUID()}`;
      payload.error = serializeIpcError(
        `service:${event.domain}`,
        event.error,
        { requestId },
        randomUUID(),
      );
    }
    send(EVENTS.SERVICE_HEALTH_CHANGED, payload);
  };
  const onOutput = (e: SessionOutputPayload): void => {
    const attachment = getOutputAttachment();
    if (!shouldForwardTerminalOutput(attachment, e)) return;
    send(EVENTS.SESSION_OUTPUT, e);
  };
  const onState = (e: SessionStateChangedPayload): void => send(EVENTS.SESSION_STATE_CHANGED, e);
  const onExited = (e: SessionExitedPayload): void => send(EVENTS.SESSION_EXITED, e);
  const onDestroyed = (e: SessionDestroyedPayload): void => send(EVENTS.SESSION_DESTROYED, e);
  const onAgentChanged = (e: IrisAgentSessionChangedPayload): void =>
    send(EVENTS.IRIS_AGENT_SESSION_CHANGED, e);
  const onAgentDestroyed = (e: IrisAgentSessionDestroyedPayload): void =>
    send(EVENTS.IRIS_AGENT_SESSION_DESTROYED, e);
  const onMaximize = (): void => send(EVENTS.WINDOW_MAXIMIZED_CHANGED, { maximized: true });
  const onUnmaximize = (): void => send(EVENTS.WINDOW_MAXIMIZED_CHANGED, { maximized: false });

  window.on('maximize', onMaximize);
  window.on('unmaximize', onUnmaximize);
  settingsManager.on('settingsChanged', onSettings);
  projectManager.on('irisChanged', onIrisChanged);
  projectManager.on('promptChanged', onPromptChanged);
  gitManager.on('changed', onGitChanged);
  gitManager.on('healthChanged', onHealthChanged);
  projectManager.on('healthChanged', onHealthChanged);
  sessionManager.on('sessionOutput', onOutput);
  sessionManager.on('sessionStateChanged', onState);
  sessionManager.on('sessionExited', onExited);
  sessionManager.on('sessionDestroyed', onDestroyed);
  agentSessionManager.on('sessionChanged', onAgentChanged);
  agentSessionManager.on('sessionDestroyed', onAgentDestroyed);
  return () => {
    window.off('maximize', onMaximize);
    window.off('unmaximize', onUnmaximize);
    settingsManager.off('settingsChanged', onSettings);
    projectManager.off('irisChanged', onIrisChanged);
    projectManager.off('promptChanged', onPromptChanged);
    gitManager.off('changed', onGitChanged);
    gitManager.off('healthChanged', onHealthChanged);
    projectManager.off('healthChanged', onHealthChanged);
    sessionManager.off('sessionOutput', onOutput);
    sessionManager.off('sessionStateChanged', onState);
    sessionManager.off('sessionExited', onExited);
    sessionManager.off('sessionDestroyed', onDestroyed);
    agentSessionManager.off('sessionChanged', onAgentChanged);
    agentSessionManager.off('sessionDestroyed', onAgentDestroyed);
  };
}
