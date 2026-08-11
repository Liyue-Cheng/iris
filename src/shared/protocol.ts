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
  /** Query: current git HEAD sha of the project root (null when not a repo /
   *  no project / git unavailable). Powers status-doc freshness (reflects:
   *  stamp vs HEAD). Read-only — never mutates anything. */
  PROJECT_GIT_HEAD: 'project:git-head',
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
  ASSET_ADOPT: 'asset:adopt',
  ASSET_TRASH: 'asset:trash',
  /** UI helper: native folder picker (returns a path or null; no side effect). */
  DIALOG_PICK_FOLDER: 'dialog:pick-folder',
  /** Session verbs (instruction-backed). */
  SESSION_OPEN: 'session:open',
  SESSION_CLOSE: 'session:close',
  /** Re-anchor a live session to another doc (Marina 锚定模型: path edits the
   *  doc). Used by the delete-file gesture: orphaned sessions re-anchor to
   *  the project root (docPath null). The live process env is untouched —
   *  FOCUS_DOC degradation is the protocol's documented fallback. */
  SESSION_REANCHOR: 'session:reanchor',
  /**
   * Session streaming I/O — deliberately NOT instructions: keystrokes and
   * resizes are continuous interaction inside one session, not discrete
   * world-changing verbs; routing every keypress through the pipeline would
   * only add latency and log noise. Documented CQRS deviation.
   */
  SESSION_INPUT: 'session:input',
  SESSION_RESIZE: 'session:resize',
  /** Queries. */
  SESSION_LIST: 'session:list',
  SESSION_SCROLLBACK: 'session:scrollback',
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
  SESSION_OUTPUT: 'evt:session:output',
  SESSION_STATE_CHANGED: 'evt:session:state-changed',
  SESSION_EXITED: 'evt:session:exited',
  SESSION_DESTROYED: 'evt:session:destroyed',
} as const;
