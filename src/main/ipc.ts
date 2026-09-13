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
import { CHANNELS, EVENTS, type WindowEditAction } from '@shared/protocol';
import type { JtpBuiltinResult } from '@shared/agent-protocol';
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
  IrisAgentAnchor,
  IrisAgentHistoryEntry,
  IrisAgentAttachmentData,
  IrisAgentAttachmentUpload,
  IrisAgentModelCatalog,
  IrisAgentProviderCatalog,
  IrisAgentPhaseChangedPayload,
  IrisAgentSessionChangedPayload,
  IrisAgentSessionDestroyedPayload,
  IrisAgentSessionInfo,
  IrisAgentTaskLog,
  IrisAgentTerminalReplay,
  IrisAgentTerminalOutputPayload,
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
  TerminalSessionInfo,
  SessionListSnapshot,
  SessionOutputPayload,
  SessionStateChangedPayload,
  Settings,
  SettingsChangedEvent,
  WindowBootstrapState,
} from '@shared/types';
import { appDataDir, type SettingsManager } from './settings-manager';
import type { ProjectManager } from './project-manager';
import type { GitManager } from './git-manager';
import type { TerminalSessionManager } from './terminal-session-manager';
import type { IrisAgentSessionManager } from './agent/session-manager';
import {
  detachTerminalOutput,
  shouldForwardTerminalOutput,
  type TerminalOutputAttachment,
} from './terminal/output-attachment';
import { injectionState, installFocusScript, installHook, removeHook } from './agent-injection';
import {
  allContexts,
  contextForWebContents,
  persistOpenRoots,
  requireContext,
  type WindowContext,
} from './window-context';
import {
  irisPiAgentDir,
  loadIrisProviderCatalog,
  loadIrisModelCatalog,
} from './agent/pi-adapter';
import {
  addIrisAgentProviderProfile,
  removeIrisAgentProviderProfile,
  updateIrisAgentProviderProfileApiKey,
  updateIrisAgentProviderModels,
} from './agent/provider-profiles';
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
import { JTP_BUILTIN_DESCRIPTORS } from './jtp/builtin-descriptors';
import type { JtpEvent } from './jtp/protocol';
import { JtpMcpProvider, discoverMcpDescriptors } from './agent/mcp-provider';

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

function sessionsForScope(ctx: WindowContext, scope: ProjectScope): TerminalSessionInfo[] {
  return ctx.terminalSessionManager
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
): TerminalSessionInfo {
  const session = ctx.terminalSessionManager.get(sessionId);
  if (
    !session ||
    session.projectRoot !== scope.root ||
    session.projectGeneration !== scope.generation
  ) {
    throw new Error(`[${channel}] session is outside the active project scope`);
  }
  return session;
}

/**
 * Normalizes the attachment part of an Agent send payload. This is the trust
 * boundary: anything malformed is rejected here rather than carried deeper,
 * and the shape is reduced to exactly what the manager accepts, so a renderer
 * cannot smuggle extra fields past the manager's own validation.
 */
function readAttachmentUploads(value: unknown): IrisAgentAttachmentUpload[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`[${CHANNELS.IRIS_AGENT_SEND}] attachments must be an array`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`[${CHANNELS.IRIS_AGENT_SEND}] attachment ${String(index)} is invalid`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.dataBase64 !== 'string') {
      throw new Error(`[${CHANNELS.IRIS_AGENT_SEND}] attachment ${String(index)} is invalid`);
    }
    return { name: record.name, dataBase64: record.dataBase64 };
  });
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
  ipcMain.handle(CHANNELS.IRIS_AGENT_TOOLS, async () => {
    const enabled = settingsManager.get().experimental.jtpTools;
    const builtins = JTP_BUILTIN_DESCRIPTORS.map((tool) => ({ id: tool.id, title: tool.title, description: tool.description, provider: tool.provider, enabled: enabled[tool.id as keyof typeof enabled] ?? tool.enabledByDefault }));
    const mcpTools: Array<{ id: string; title: string; description: string; provider: string; enabled: boolean }> = [];
    for (const server of settingsManager.get().experimental.mcpServers) {
      const provider = new JtpMcpProvider(server);
      try {
        const descriptors = await discoverMcpDescriptors(provider, server.id);
        for (const descriptor of descriptors) {
          mcpTools.push({
            id: descriptor.id,
            title: descriptor.title,
            description: descriptor.description,
            provider: descriptor.provider,
            enabled: enabled[descriptor.id as keyof typeof enabled] ?? descriptor.enabledByDefault,
          });
        }
      } catch {
        mcpTools.push({ id: `mcp.${server.id}`, title: server.id, description: 'MCP server unavailable.', provider: `mcp:${server.id}`, enabled: false });
      } finally {
        await provider.close();
      }
    }
    return [...builtins, ...mcpTools];
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
        const session = ctx.terminalSessionManager.createCommandSession({
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
    CHANNELS.ASSET_LINK_ADD,
    (event, payload: { docPath: string; targetPath: string } & ProjectScopedPayload) => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.ASSET_LINK_ADD);
      return ctx.projectManager.addAssociatedPath(payload.docPath, payload.targetPath);
    },
  );

  ipcMain.handle(
    CHANNELS.ASSET_LINK_REMOVE,
    async (event, payload: { docPath: string; targetPath: string } & ProjectScopedPayload): Promise<void> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.ASSET_LINK_REMOVE);
      await ctx.projectManager.removeAssociatedPath(payload.docPath, payload.targetPath);
    },
  );

  ipcMain.handle(
    CHANNELS.ASSET_LINK_OPEN,
    async (event, payload: { docPath: string; targetPath: string } & ProjectScopedPayload): Promise<void> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.ASSET_LINK_OPEN);
      const target = await ctx.projectManager.resolveAssociatedPath(payload.docPath, payload.targetPath);
      const error = await shell.openPath(target);
      if (error) throw new Error(`[${CHANNELS.ASSET_LINK_OPEN}] ${error}`);
    },
  );

  ipcMain.handle(
    CHANNELS.ASSET_LINK_REVEAL,
    async (event, payload: { docPath: string; targetPath: string } & ProjectScopedPayload): Promise<void> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.ASSET_LINK_REVEAL);
      const target = await ctx.projectManager.resolveAssociatedPath(payload.docPath, payload.targetPath);
      shell.showItemInFolder(target);
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
    ): Promise<TerminalSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.SESSION_OPEN);
      return ctx.terminalSessionManager.createSession({
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
      return ctx.terminalSessionManager.closeSession(payload.sessionId);
    },
  );

  ipcMain.handle(
    CHANNELS.SESSION_REANCHOR,
    (
      event,
      payload: {
        sessionId: string;
        docPath: string | null;
        workspacePath?: string | null;
      } & ProjectScopedPayload,
    ): TerminalSessionInfo => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.SESSION_REANCHOR);
      requireSessionInScope(ctx, payload.sessionId, scope, CHANNELS.SESSION_REANCHOR);
      return ctx.terminalSessionManager.reanchor(
        payload.sessionId,
        payload.docPath,
        payload.workspacePath,
      );
    },
  );

  ipcMain.handle(
    CHANNELS.SESSION_INPUT,
    (event, payload: { sessionId: string; data: string } & ProjectScopedPayload) => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.SESSION_INPUT);
      requireSessionInScope(ctx, payload.sessionId, scope, CHANNELS.SESSION_INPUT);
      return ctx.terminalSessionManager.sendInput(payload.sessionId, payload.data);
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
      return ctx.terminalSessionManager.resize(payload.sessionId, payload.cols, payload.rows);
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
        ctx.terminalSessionManager.detachOutput(ctx.outputAttachment.attachmentId);
      }
      ctx.terminalSessionManager.attachOutput(payload.sessionId, payload.attachmentId);
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
      ctx.terminalSessionManager.detachOutput(payload.attachmentId);
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
      ctx.terminalSessionManager.acknowledgeOutput(
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
      payload: {
        sessionId: string;
        message: string;
        /**
         * Images the request carries, as `{ name, dataBase64 }` only. Main
         * sniffs the MIME type and size from the bytes, so nothing the
         * renderer claims about an upload is trusted.
         */
        attachments?: unknown;
        commandId?: string;
        expectedRevision?: number;
      } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_SEND);
      return ctx.agentSessionManager.send(
        scope,
        payload.sessionId,
        payload.message,
        {
          ...(payload.commandId ? { commandId: payload.commandId } : {}),
          ...(payload.expectedRevision === undefined
            ? {}
            : { expectedRevision: payload.expectedRevision }),
        },
        readAttachmentUploads(payload.attachments),
      );
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_STOP,
    (
      event,
      payload: {
        sessionId: string;
        commandId?: string;
        expectedRevision?: number;
        expectedIntentId?: string;
      } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_STOP);
      return ctx.agentSessionManager.stop(scope, payload.sessionId, {
        ...(payload.commandId ? { commandId: payload.commandId } : {}),
        ...(payload.expectedRevision === undefined
          ? {}
          : { expectedRevision: payload.expectedRevision }),
        ...(payload.expectedIntentId === undefined ? {} : { expectedIntentId: payload.expectedIntentId }),
      });
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_RETRY,
    (
      event,
      payload: { sessionId: string; commandId?: string; expectedRevision?: number } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_RETRY);
      return ctx.agentSessionManager.retry(scope, payload.sessionId, {
        ...(payload.commandId ? { commandId: payload.commandId } : {}),
        ...(payload.expectedRevision === undefined
          ? {}
          : { expectedRevision: payload.expectedRevision }),
      });
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_REWIND,
    (
      event,
      payload: { sessionId: string; commandId?: string; expectedRevision?: number } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_REWIND);
      return ctx.agentSessionManager.rewind(scope, payload.sessionId, {
        ...(payload.commandId ? { commandId: payload.commandId } : {}),
        ...(payload.expectedRevision === undefined
          ? {}
          : { expectedRevision: payload.expectedRevision }),
      });
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_BRANCH,
    (
      event,
      payload: {
        sessionId: string;
        throughIntentId: string;
        commandId?: string;
        expectedRevision?: number;
      } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_BRANCH);
      return ctx.agentSessionManager.branch(scope, payload.sessionId, payload.throughIntentId, {
        ...(payload.commandId ? { commandId: payload.commandId } : {}),
        ...(payload.expectedRevision === undefined
          ? {}
          : { expectedRevision: payload.expectedRevision }),
      });
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_BRANCH_INPUT,
    (
      event,
      payload: {
        sessionId: string;
        throughIntentId: string;
        commandId?: string;
        expectedRevision?: number;
      } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_BRANCH_INPUT);
      return ctx.agentSessionManager.branchFromInput(scope, payload.sessionId, payload.throughIntentId, {
        ...(payload.commandId ? { commandId: payload.commandId } : {}),
        ...(payload.expectedRevision === undefined
          ? {}
          : { expectedRevision: payload.expectedRevision }),
      });
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_SET_MODEL,
    (
      event,
      payload: {
        sessionId: string;
        provider: string;
        modelId: string;
        commandId?: string;
        expectedRevision?: number;
      } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_SET_MODEL);
      return ctx.agentSessionManager.setModel(
        scope,
        payload.sessionId,
        { provider: payload.provider, modelId: payload.modelId },
        {
          ...(payload.commandId ? { commandId: payload.commandId } : {}),
          ...(payload.expectedRevision === undefined
            ? {}
            : { expectedRevision: payload.expectedRevision }),
        },
      );
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_MODELS,
    (event, payload: { forceRefresh?: boolean } & ProjectScopedPayload): Promise<IrisAgentModelCatalog> => {
      const ctx = requireContext(event);
      requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_MODELS);
      return ctx.agentSessionManager.listModels(payload.forceRefresh === true);
    },
  );

  const prepareProviderConfigurationChange = (): void => {
    for (const ctx of allContexts()) {
      ctx.agentSessionManager.assertProviderConfigurationChangeAllowed();
    }
  };
  const finishProviderConfigurationChange = async (): Promise<void> => {
    await Promise.all(
      allContexts().map((ctx) => ctx.agentSessionManager.reloadProviderConfiguration()),
    );
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(EVENTS.IRIS_AGENT_PROVIDERS_CHANGED, undefined);
      }
    }
  };

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_PROVIDERS,
    (): Promise<IrisAgentProviderCatalog> => loadIrisProviderCatalog(appDataDir(), irisPiAgentDir()),
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_PROVIDER_PROFILE_ADD,
    async (
      _event,
      payload: { name: string; templateId: string; baseUrl: string; apiKey: string },
    ): Promise<IrisAgentProviderCatalog> => {
      prepareProviderConfigurationChange();
      await addIrisAgentProviderProfile(payload, appDataDir());
      await finishProviderConfigurationChange();
      return loadIrisProviderCatalog(appDataDir(), irisPiAgentDir());
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_PROVIDER_PROFILE_REMOVE,
    async (
      _event,
      payload: { profileId: string },
    ): Promise<IrisAgentProviderCatalog> => {
      prepareProviderConfigurationChange();
      await removeIrisAgentProviderProfile(payload.profileId, appDataDir());
      await finishProviderConfigurationChange();
      return loadIrisProviderCatalog(appDataDir(), irisPiAgentDir());
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_PROVIDER_PROFILE_SET_KEY,
    async (
      _event,
      payload: { profileId: string; apiKey: string },
    ): Promise<IrisAgentProviderCatalog> => {
      prepareProviderConfigurationChange();
      await updateIrisAgentProviderProfileApiKey(payload.profileId, payload.apiKey, appDataDir());
      await finishProviderConfigurationChange();
      return loadIrisProviderCatalog(appDataDir(), irisPiAgentDir());
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_PROVIDER_PROFILE_MODELS,
    async (
      _event,
      payload: { profileId: string; models: import('@shared/types').IrisAgentConfiguredModel[] },
    ): Promise<IrisAgentProviderCatalog> => {
      prepareProviderConfigurationChange();
      await updateIrisAgentProviderModels(payload.profileId, payload.models, appDataDir());
      await finishProviderConfigurationChange();
      return loadIrisProviderCatalog(appDataDir(), irisPiAgentDir());
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_PROVIDER_PROFILE_DISCOVER,
    async (_event, payload: { profileId: string }): Promise<IrisAgentProviderCatalog> => {
      prepareProviderConfigurationChange();
      const profileCatalog = await loadIrisProviderCatalog(appDataDir(), irisPiAgentDir());
      const profile = profileCatalog.profiles.find((item) => item.id === payload.profileId);
      if (!profile) throw new Error('Provider profile was not found.');
      const discovered = await loadIrisModelCatalog(irisPiAgentDir(), appDataDir(), true);
      const remoteModels = discovered.models
        .filter((model) => model.provider === `iris-profile-${payload.profileId}`)
      const existingById = new Map((profile.models ?? []).map((model) => [model.modelId, model]));
      const remoteIds = new Set(remoteModels.map((model) => model.modelId));
      const models = [
        ...remoteModels.map((model) => {
          const existing = existingById.get(model.modelId);
          if (existing) return { ...existing };
          const contextWindowTokens = model.contextWindowTokens ?? 128_000;
          const reserveOutputTokens = 16_384;
          return {
            modelId: model.modelId,
            displayName: model.name,
            ...(model.capabilities?.input ? { input: [...model.capabilities.input] } : {}),
            api: model.api === 'anthropic-messages' ? 'anthropic-messages' as const : 'openai-responses' as const,
            contextWindowTokens,
            maxOutputTokens: model.maxOutputTokens ?? reserveOutputTokens,
            reserveOutputTokens,
            keepRecentTokens: 20_000,
            compactTrigger: Math.max(1, contextWindowTokens - reserveOutputTokens),
            customParameters: {},
            enabled: true,
            source: 'discovered' as const,
          };
        }),
        ...(profile.models ?? []).filter((model) => model.source === 'manual' && !remoteIds.has(model.modelId)),
      ];
      if (models.length === 0) throw new Error(discovered.error ?? '供应商目录没有返回模型。');
      await updateIrisAgentProviderModels(payload.profileId, models, appDataDir());
      await finishProviderConfigurationChange();
      return loadIrisProviderCatalog(appDataDir(), irisPiAgentDir());
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_OPEN_CONTEXT,
    async (
      event,
      payload: { sessionId: string; intentId: string } & ProjectScopedPayload,
    ): Promise<void> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_OPEN_CONTEXT);
      const target = await ctx.agentSessionManager.getIntentArtifactPath(
        scope,
        payload.sessionId,
        payload.intentId,
      );
      const error = await shell.openPath(target);
      if (error) throw new Error(`[${CHANNELS.IRIS_AGENT_OPEN_CONTEXT}] ${error}`);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_ATTACHMENT_READ,
    (
      event,
      payload: { sessionId: string; attachmentId: string } & ProjectScopedPayload,
    ): Promise<IrisAgentAttachmentData> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_ATTACHMENT_READ);
      return ctx.agentSessionManager.readAttachmentData(
        scope,
        payload.sessionId,
        payload.attachmentId,
      );
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_TERMINAL_REPLAY,
    (
      event,
      payload: { sessionId: string; terminalId: string; cols: number; rows: number } & ProjectScopedPayload,
    ): Promise<IrisAgentTerminalReplay> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_TERMINAL_REPLAY);
      return ctx.agentSessionManager.replayTerminal(
        scope, payload.sessionId, payload.terminalId, payload.cols, payload.rows,
      );
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_TERMINAL_ATTACH,
    (
      event,
      payload: { sessionId: string; terminalId: string; attachmentId: string } & ProjectScopedPayload,
    ): boolean => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_TERMINAL_ATTACH);
      return ctx.agentSessionManager.attachTerminalOutput(
        scope, payload.sessionId, payload.terminalId, payload.attachmentId,
      );
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_TERMINAL_DETACH,
    (
      event,
      payload: { sessionId: string; terminalId: string; attachmentId: string } & ProjectScopedPayload,
    ): void => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_TERMINAL_DETACH);
      ctx.agentSessionManager.detachTerminalOutput(
        scope, payload.sessionId, payload.terminalId, payload.attachmentId,
      );
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_TERMINAL_ACK,
    (
      event,
      payload: {
        sessionId: string;
        terminalId: string;
        attachmentId: string;
        seq: number;
      } & ProjectScopedPayload,
    ): void => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_TERMINAL_ACK);
      ctx.agentSessionManager.acknowledgeTerminalOutput(
        scope, payload.sessionId, payload.terminalId, payload.attachmentId, payload.seq,
      );
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_TERMINAL_INPUT,
    (
      event,
      payload: { sessionId: string; terminalId: string; data: string } & ProjectScopedPayload,
    ): Promise<void> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_TERMINAL_INPUT);
      return ctx.agentSessionManager.writeTerminal(scope, payload.sessionId, payload.terminalId, payload.data);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_TERMINAL_RESIZE,
    (
      event,
      payload: { sessionId: string; terminalId: string; cols: number; rows: number } & ProjectScopedPayload,
    ): Promise<void> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_TERMINAL_RESIZE);
      return ctx.agentSessionManager.resizeTerminal(
        scope, payload.sessionId, payload.terminalId, payload.cols, payload.rows,
      );
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_SUPERVISION_CONTINUE,
    (
      event,
      payload: { sessionId: string; terminalId: string } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_SUPERVISION_CONTINUE);
      return ctx.agentSessionManager.continueTerminalSupervision(
        scope, payload.sessionId, payload.terminalId,
      );
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_COUNT_DOCUMENTS,
    (
      event,
      payload: { documentPaths: string[] } & ProjectScopedPayload,
    ): Promise<number> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_COUNT_DOCUMENTS);
      return ctx.agentSessionManager.countDocumentSessions(scope, payload.documentPaths);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_ARCHIVE_DOCUMENTS,
    (
      event,
      payload: { documentPaths: string[] } & ProjectScopedPayload,
    ): Promise<number> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_ARCHIVE_DOCUMENTS);
      return ctx.agentSessionManager.archiveDocumentSessions(scope, payload.documentPaths);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_CLOSE,
    (
      event,
      payload: { sessionId: string; commandId?: string; expectedRevision?: number; confirmBusy?: boolean } & ProjectScopedPayload,
    ): Promise<void> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_CLOSE);
      return ctx.agentSessionManager.closeSession(scope, payload.sessionId, {
        ...(payload.commandId ? { commandId: payload.commandId } : {}),
        ...(payload.expectedRevision === undefined
          ? {}
          : { expectedRevision: payload.expectedRevision }),
        ...(payload.confirmBusy === true ? { confirmBusy: true } : {}),
      });
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
    CHANNELS.IRIS_AGENT_HISTORY,
    (
      event,
      payload: { anchor: IrisAgentAnchor } & ProjectScopedPayload,
    ): Promise<IrisAgentHistoryEntry[]> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_HISTORY);
      return ctx.agentSessionManager.history(scope, payload.anchor);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_REOPEN,
    (
      event,
      payload: { sessionId: string } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_REOPEN);
      return ctx.agentSessionManager.reopen(scope, payload.sessionId);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_RESTORE,
    (
      event,
      payload: { sessionId: string } & ProjectScopedPayload,
    ): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_RESTORE);
      return ctx.agentSessionManager.restore(scope, payload.sessionId);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_TASK_GET,
    (event, payload: { taskId: string; cursor?: string; maxBytes?: number } & ProjectScopedPayload): Promise<JtpBuiltinResult> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_TASK_GET);
      return ctx.agentSessionManager.getTask(scope, payload.taskId, payload.cursor, payload.maxBytes);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_TASK_LIST,
    (event, payload: { scope?: 'active' | 'all'; cursor?: string; limit?: number } & ProjectScopedPayload): Promise<JtpBuiltinResult> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_TASK_LIST);
      return ctx.agentSessionManager.listTasks(scope, payload.scope, payload.cursor, payload.limit);
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_TASK_LOG,
    (
      event,
      payload: {
        sessionId: string;
        taskId: string;
        cursor?: number;
        maxBytes?: number;
      } & ProjectScopedPayload,
    ): Promise<IrisAgentTaskLog> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_TASK_LOG);
      return ctx.agentSessionManager.readTaskLog(
        scope, payload.sessionId, payload.taskId, payload.cursor, payload.maxBytes,
      );
    },
  );

  ipcMain.handle(
    CHANNELS.IRIS_AGENT_TASK_CANCEL,
    (event, payload: { sessionId: string; taskId: string } & ProjectScopedPayload): Promise<IrisAgentSessionInfo> => {
      const ctx = requireContext(event);
      const scope = requireProjectScope(ctx, payload, CHANNELS.IRIS_AGENT_TASK_CANCEL);
      return ctx.agentSessionManager.cancelTask(scope, payload.sessionId, payload.taskId);
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
      return ctx.terminalSessionManager.prepareReplay(
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

  ipcMain.handle(
    CHANNELS.DIALOG_PICK_ASSET_PATH,
    async (event, payload: { kind: 'file' | 'directory' }): Promise<string | null> => {
      const parent = senderWindow(event);
      const properties: Array<'openFile' | 'openDirectory'> = payload?.kind === 'directory' ? ['openDirectory'] : ['openFile'];
      const options = { title: mainT(payload?.kind === 'directory' ? 'app.addAssociatedFolder' : 'app.addAssociatedFile'), properties };
      const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
  );

  logger.info('ipc', 'handlers registered');
}

/** Forward manager events to a window. Returns an unsubscribe fn. */
export function wireBroadcasts(
  settingsManager: SettingsManager,
  projectManager: ProjectManager,
  gitManager: GitManager,
  terminalSessionManager: TerminalSessionManager,
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
  const onJtpSettings = (): void => send(EVENTS.IRIS_AGENT_TOOLS_CHANGED, undefined);
  const onIrisChanged = (e: FsIrisChangedEvent): void => {
    const scope = getProjectScope();
    if (!scope || scope.root !== e.projectRoot) return;
    // Keep document-anchored PTYs visible when an external file operation
    // removes their document. The session manager owns the live PTY and must
    // update its projection before the renderer rescans the .iris tree.
    terminalSessionManager.reanchorDeletedDocuments(e.changes, scope);
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
  const onAgentPhaseChanged = (e: IrisAgentPhaseChangedPayload): void =>
    send(EVENTS.IRIS_AGENT_PHASE_CHANGED, e);
  const onAgentDestroyed = (e: IrisAgentSessionDestroyedPayload): void =>
    send(EVENTS.IRIS_AGENT_SESSION_DESTROYED, e);
  const onAgentTerminalOutput = (e: IrisAgentTerminalOutputPayload): void =>
    send(EVENTS.IRIS_AGENT_TERMINAL_OUTPUT, e);
  const onJtpEvent = (e: JtpEvent): void => send(EVENTS.IRIS_AGENT_JTP_EVENT, e);
  const onMaximize = (): void => send(EVENTS.WINDOW_MAXIMIZED_CHANGED, { maximized: true });
  const onUnmaximize = (): void => send(EVENTS.WINDOW_MAXIMIZED_CHANGED, { maximized: false });

  window.on('maximize', onMaximize);
  window.on('unmaximize', onUnmaximize);
  settingsManager.on('settingsChanged', onSettings);
  settingsManager.on('settingsChanged', onJtpSettings);
  projectManager.on('irisChanged', onIrisChanged);
  projectManager.on('promptChanged', onPromptChanged);
  gitManager.on('changed', onGitChanged);
  gitManager.on('healthChanged', onHealthChanged);
  projectManager.on('healthChanged', onHealthChanged);
  terminalSessionManager.on('sessionOutput', onOutput);
  terminalSessionManager.on('sessionStateChanged', onState);
  terminalSessionManager.on('sessionExited', onExited);
  terminalSessionManager.on('sessionDestroyed', onDestroyed);
  agentSessionManager.on('sessionChanged', onAgentChanged);
  agentSessionManager.on('phaseChanged', onAgentPhaseChanged);
  agentSessionManager.on('sessionDestroyed', onAgentDestroyed);
  agentSessionManager.on('terminalOutput', onAgentTerminalOutput);
  agentSessionManager.on('jtpEvent', onJtpEvent);
  return () => {
    window.off('maximize', onMaximize);
    window.off('unmaximize', onUnmaximize);
    settingsManager.off('settingsChanged', onSettings);
    settingsManager.off('settingsChanged', onJtpSettings);
    projectManager.off('irisChanged', onIrisChanged);
    projectManager.off('promptChanged', onPromptChanged);
    gitManager.off('changed', onGitChanged);
    gitManager.off('healthChanged', onHealthChanged);
    projectManager.off('healthChanged', onHealthChanged);
    terminalSessionManager.off('sessionOutput', onOutput);
    terminalSessionManager.off('sessionStateChanged', onState);
    terminalSessionManager.off('sessionExited', onExited);
    terminalSessionManager.off('sessionDestroyed', onDestroyed);
    agentSessionManager.off('sessionChanged', onAgentChanged);
    agentSessionManager.off('phaseChanged', onAgentPhaseChanged);
    agentSessionManager.off('sessionDestroyed', onAgentDestroyed);
    agentSessionManager.off('terminalOutput', onAgentTerminalOutput);
    agentSessionManager.off('jtpEvent', onJtpEvent);
  };
}

