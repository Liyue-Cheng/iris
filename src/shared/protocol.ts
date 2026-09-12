/**
 * @file src/shared/protocol.ts
 * @purpose IPC channel names, shared by main (handlers), preload (bridge)
 *   and renderer (front-cpu ipc executor configs).
 *
 * Naming: `<domain>:<operation>` for invoke channels, `evt:<domain>:<event>`
 * for main → renderer pushes.
 */

export const CHANNELS = {
  APP_PING: 'app:ping',
  /** Machine-level product/runtime facts for the About panel. */
  APP_INFO: 'app:info',
  /** Product-scoped helpers. Payloads contain only fixed document/link ids. */
  APP_OPEN_LEGAL_DOCUMENT: 'app:open-legal-document',
  APP_OPEN_EXTERNAL_LINK: 'app:open-external-link',
  APP_REVEAL_USER_DATA: 'app:reveal-user-data',
  /** Renderer → main result of the close-time editor flush. `{ ok: false }`
   *  cancels close when a conflict or write failure still owns the draft. */
  APP_FLUSH_DONE: 'app:flush-done',
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  /** Verb (instruction-backed): open a project, start watching, persist lastRoot. */
  PROJECT_OPEN: 'project:open',
  /** Read-side projection for the welcome page's MRU list. */
  PROJECT_RECENT_LIST: 'project:recent-list',
  /** Verb: forget one entry from the welcome page's MRU list. */
  PROJECT_RECENT_REMOVE: 'project:recent-remove',
  /** Verb: idempotent protocol scaffold (folders + AGENTS.md). */
  PROJECT_INIT: 'project:init',
  /** Verb: create a sub-workspace (human gesture only). */
  WORKSPACE_CREATE: 'workspace:create',
  /** Context-injection adapter layer (round-3 A 条): focus-context script in
   *  ~/.iris/ + SessionStart hooks in the user's agent CLI configs. State is
   *  a query; user-config writes/removals are verbs gated behind explicit
   *  confirmation in the settings UI. */
  AGENT_INJECTION_STATE: 'agent:injection-state',
  AGENT_INSTALL_FOCUS_SCRIPT: 'agent:install-focus-script',
  AGENT_INSTALL_HOOK: 'agent:install-hook',
  AGENT_REMOVE_HOOK: 'agent:remove-hook',
  /** Prompt governance for project-root entry-file blocks. */
  SOFTWARE_PROMPT_STATE: 'software-prompt:state',
  /** Read-only: the prompt layers' on-disk text + assembled injection, for the
   *  settings viewer (content behind the freshness badges). */
  SOFTWARE_PROMPT_PREVIEW: 'software-prompt:preview',
  SOFTWARE_PROMPT_SYNC_ENTRY: 'software-prompt:sync-entry',
  PROMPT_SYNC_ALL: 'prompt:sync-all',
  PROMPT_ENTRY_ADD: 'prompt:entry-add',
  PROMPT_ENTRY_REMOVE: 'prompt:entry-remove',
  PROJECT_PROMPT_SYNC: 'project-prompt:sync',
  PROJECT_PROMPT_RESTORE_ENTRY: 'project-prompt:restore-entry',
  /** Project-level App settings stored in .iris/settings.json. */
  PROJECT_SETTINGS_GET: 'project-settings:get',
  PROJECT_SETTINGS_UPDATE_TOOLBAR: 'project-settings:update-toolbar',
  PROJECT_COMMAND_RUN: 'project-command:run',
  /** UI helper: reveal a path in the system file manager. */
  SHELL_REVEAL: 'shell:reveal',
  /** UI helper: open a path with its operating-system default application. */
  SHELL_OPEN_PATH: 'shell:open-path',
  /** UI helper: open an http(s) or mailto URL in the system handler. */
  SHELL_OPEN_EXTERNAL_URL: 'shell:open-external-url',
  /**
   * Clipboard bridge — main-side Electron clipboard module. Marina's lesson:
   * navigator.clipboard needs web Permission API grants in the Electron
   * file:// context and fails silently; the IPC bridge has no permission
   * layer. UI helpers, same CQRS deviation class as WINDOW_*.
   */
  CLIPBOARD_READ_TEXT: 'clipboard:read-text',
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',
  /**
   * Window chrome for the frameless custom title bar. UI helpers, not verbs:
   * minimize/maximize/close are window furniture, same CQRS deviation class
   * as SESSION_INPUT.
   */
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE_TOGGLE: 'window:maximize-toggle',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  /** Editing UI helper: webContents cut/copy/paste/selectAll on the focused
   *  editable (the editor context menu) — clipboard fidelity the renderer
   *  can't reach (execCommand('paste') is privileged). */
  WINDOW_EDIT_ACTION: 'window:edit-action',
  /** Query: which project root THIS window is bound to (multi-window). The
   *  renderer asks at boot and opens that project — main is the authority on
   *  the window→project binding, the renderer doesn't guess from settings. */
  WINDOW_BOOTSTRAP: 'window:bootstrap',
  /** Verb-ish: open a project in a NEW window (VS Code "Open Folder in New
   *  Window"). Optional root; with none, main shows the folder picker. */
  WINDOW_OPEN_PROJECT: 'window:open-project',
  /** Queries (projection reads — not instructions). */
  PROJECT_SCAN: 'project:scan',
  PROJECT_RAW_TREE: 'project:raw-tree',
  GIT_STATUS: 'git:status',
  GIT_REFRESH: 'git:refresh',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_COMMIT: 'git:commit',
  GIT_SWITCH_BRANCH: 'git:switch-branch',
  DOC_READ: 'doc:read',
  /** Query: read an image referenced relative to a Markdown document. The
   *  main process confines the path to the project and returns a data URL. */
  DOC_IMAGE_READ: 'doc:image-read',
  /** Verbs (instruction-backed): write a doc verbatim / create a typed doc /
   *  delete a doc (the software protocol's "do not delete" rule binds the
   *  agent's write-back, not the user's UI gesture). */
  DOC_WRITE: 'doc:write',
  DOC_CREATE: 'doc:create',
  DOC_DELETE: 'doc:delete',
  /** Managed companion assets for one Markdown document. List is a query;
   *  import/trash are human editing gestures routed through the CPU. */
  ASSET_LIST: 'asset:list',
  ASSET_IMPORT: 'asset:import',
  ASSET_LINK_ADD: 'asset:link-add',
  ASSET_LINK_REMOVE: 'asset:link-remove',
  ASSET_LINK_OPEN: 'asset:link-open',
  ASSET_LINK_REVEAL: 'asset:link-reveal',
  /** UI helper: native folder picker (returns a path or null; no side effect). */
  DIALOG_PICK_FOLDER: 'dialog:pick-folder',
  DIALOG_PICK_ASSET_PATH: 'dialog:pick-asset-path',
  /** Session verbs (instruction-backed). */
  SESSION_OPEN: 'session:open',
  SESSION_CLOSE: 'session:close',
  /** Re-anchor a live session to another doc (Marina 锚定模型: path edits the
   *  doc). Used by the delete-file gesture and external-delete recovery:
   *  orphaned sessions re-anchor to a workspace/root hub (docPath null). The
   *  live process env is untouched — FOCUS_DOC degradation is the protocol's
   *  documented fallback. */
  SESSION_REANCHOR: 'session:reanchor',
  /**
   * Session streaming I/O — deliberately NOT instructions: keystrokes and
   * resizes are continuous interaction inside one session, not discrete
   * world-changing verbs; routing every keypress through the pipeline would
   * only add latency and log noise. Documented CQRS deviation.
   */
  SESSION_INPUT: 'session:input',
  SESSION_RESIZE: 'session:resize',
  SESSION_OUTPUT_ATTACH: 'session:output-attach',
  SESSION_OUTPUT_DETACH: 'session:output-detach',
  SESSION_OUTPUT_ACK: 'session:output-ack',
  /** Queries. */
  SESSION_LIST: 'session:list',
  SESSION_SCROLLBACK: 'session:scrollback',
  /** Iris Agent verbs and projections. */
  IRIS_AGENT_OPEN: 'iris-agent:open',
  IRIS_AGENT_SEND: 'iris-agent:send',
  IRIS_AGENT_STOP: 'iris-agent:stop',
  IRIS_AGENT_RETRY: 'iris-agent:retry',
  IRIS_AGENT_REWIND: 'iris-agent:rewind',
  IRIS_AGENT_BRANCH: 'iris-agent:branch',
  IRIS_AGENT_BRANCH_INPUT: 'iris-agent:branch-input',
  IRIS_AGENT_SET_MODEL: 'iris-agent:set-model',
  IRIS_AGENT_MODELS: 'iris-agent:models',
  IRIS_AGENT_PROVIDERS: 'iris-agent:providers',
  IRIS_AGENT_PROVIDER_PROFILE_ADD: 'iris-agent:provider-profile-add',
  IRIS_AGENT_PROVIDER_PROFILE_SET_KEY: 'iris-agent:provider-profile-set-key',
  IRIS_AGENT_PROVIDER_PROFILE_REMOVE: 'iris-agent:provider-profile-remove',
  IRIS_AGENT_PROVIDER_PROFILE_MODELS: 'iris-agent:provider-profile-models',
  IRIS_AGENT_PROVIDER_PROFILE_DISCOVER: 'iris-agent:provider-profile-discover',
  IRIS_AGENT_OPEN_CONTEXT: 'iris-agent:open-context',
  /**
   * Query: read one stored Agent image for display. The renderer supplies a
   * session and attachment id only; main resolves the file and MIME type from
   * its own record, so this cannot be used to read an arbitrary path.
   */
  IRIS_AGENT_ATTACHMENT_READ: 'iris-agent:attachment-read',
  IRIS_AGENT_TERMINAL_REPLAY: 'iris-agent:terminal-replay',
  /**
   * Agent terminal streaming I/O — like SESSION_* streaming, deliberately not a
   * pipeline instruction: attaching a dialog to one command's live output is
   * continuous interaction, not a discrete verb.
   */
  IRIS_AGENT_TERMINAL_ATTACH: 'iris-agent:terminal-attach',
  IRIS_AGENT_TERMINAL_DETACH: 'iris-agent:terminal-detach',
  IRIS_AGENT_TERMINAL_ACK: 'iris-agent:terminal-ack',
  IRIS_AGENT_TERMINAL_INPUT: 'iris-agent:terminal-input',
  IRIS_AGENT_TERMINAL_RESIZE: 'iris-agent:terminal-resize',
  IRIS_AGENT_SUPERVISION_CONTINUE: 'iris-agent:supervision-continue',
  /** Anchor-scoped history of this document's Agent Sessions (live + closed). */
  IRIS_AGENT_HISTORY: 'iris-agent:history',
  /** Switch back into a closed history Session (clears its `closedAt`). */
  IRIS_AGENT_REOPEN: 'iris-agent:reopen',
  /** Open a new live Session inheriting the selected history Session's Trace. */
  IRIS_AGENT_RESTORE: 'iris-agent:restore',
  /** Count live Agent Sessions anchored to the supplied documents. */
  IRIS_AGENT_COUNT_DOCUMENTS: 'iris-agent:count-documents',
  /** Archive every live Agent Session anchored to the supplied documents. */
  IRIS_AGENT_ARCHIVE_DOCUMENTS: 'iris-agent:archive-documents',
  IRIS_AGENT_CLOSE: 'iris-agent:close',
  IRIS_AGENT_LIST: 'iris-agent:list',
  IRIS_AGENT_TASK_GET: 'iris-agent:task-get',
  IRIS_AGENT_TASK_LIST: 'iris-agent:task-list',
  IRIS_AGENT_TASK_CANCEL: 'iris-agent:task-cancel',
  /**
   * Renderer-facing task log page (byte cursor). Deliberately separate from
   * IRIS_AGENT_TASK_GET: that one answers the model with a JSON envelope, and
   * the dialog must not reverse-engineer it to render bytes.
   */
  IRIS_AGENT_TASK_LOG: 'iris-agent:task-log',
} as const;

export type WindowEditAction = 'cut' | 'copy' | 'paste' | 'selectAll';

export const EVENTS = {
  SETTINGS_CHANGED: 'evt:settings:changed',
  /** Main → renderer: window is closing, flush unsaved editor work now. */
  APP_FLUSH_BEFORE_QUIT: 'evt:app:flush-before-quit',
  /** Maximize/restore state for the custom title bar's caption button. */
  WINDOW_MAXIMIZED_CHANGED: 'evt:window:maximized-changed',
  /** Batched .iris/ tree changes (chokidar, debounced in main). */
  FS_IRIS_CHANGED: 'evt:fs:iris-changed',
  PROMPT_CHANGED: 'evt:prompt:changed',
  GIT_CHANGED: 'evt:git:changed',
  SERVICE_HEALTH_CHANGED: 'evt:service:health-changed',
  SESSION_OUTPUT: 'evt:session:output',
  SESSION_STATE_CHANGED: 'evt:session:state-changed',
  SESSION_EXITED: 'evt:session:exited',
  SESSION_DESTROYED: 'evt:session:destroyed',
  IRIS_AGENT_SESSION_CHANGED: 'evt:iris-agent:session-changed',
  IRIS_AGENT_PHASE_CHANGED: 'evt:iris-agent:phase-changed',
  IRIS_AGENT_SESSION_DESTROYED: 'evt:iris-agent:session-destroyed',
  IRIS_AGENT_PROVIDERS_CHANGED: 'evt:iris-agent:providers-changed',
  IRIS_AGENT_TERMINAL_OUTPUT: 'evt:iris-agent:terminal-output',
} as const;
