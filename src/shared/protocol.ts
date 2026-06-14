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
  /** Renderer → main ack that the close-time editor flush finished (B3).
   *  Main awaits this (with a timeout) before destroying the window. */
  APP_FLUSH_DONE: 'app:flush-done',
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  /** Verb (instruction-backed): open a project, start watching, persist lastRoot. */
  PROJECT_OPEN: 'project:open',
  /** Verb: idempotent protocol scaffold (folders + constitution + AGENTS.md). */
  PROJECT_INIT: 'project:init',
  /** Verb: create a sub-workspace (human gesture only). */
  WORKSPACE_CREATE: 'workspace:create',
  /** Machine layer (~/.iris/CONVENTIONS.md): install template / state query. */
  MACHINE_INSTALL_CONVENTIONS: 'machine:install-conventions',
  MACHINE_CONVENTIONS_STATE: 'machine:conventions-state',
  /** Context-injection adapter layer (round-3 A 条): focus-context script in
   *  ~/.iris/ + SessionStart hooks in the user's agent CLI configs. State is
   *  a query; the two installs are verbs gated behind explicit confirmation
   *  in the settings UI. */
  AGENT_INJECTION_STATE: 'agent:injection-state',
  AGENT_INSTALL_FOCUS_SCRIPT: 'agent:install-focus-script',
  AGENT_INSTALL_HOOK: 'agent:install-hook',
  /** UI helper: reveal a path in the system file manager. */
  SHELL_REVEAL: 'shell:reveal',
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
  /** Queries (projection reads — not instructions). */
  PROJECT_SCAN: 'project:scan',
  PROJECT_RAW_TREE: 'project:raw-tree',
  /** Query: current git HEAD sha of the project root (null when not a repo /
   *  no project / git unavailable). Powers status-doc freshness (reflects:
   *  stamp vs HEAD). Read-only — never mutates anything. */
  PROJECT_GIT_HEAD: 'project:git-head',
  DOC_READ: 'doc:read',
  /** Verbs (instruction-backed): write a doc verbatim / create a typed doc /
   *  delete a doc (human UI gesture — CONVENTIONS' "do not delete" binds the
   *  agent's write-back, not the user). */
  DOC_WRITE: 'doc:write',
  DOC_CREATE: 'doc:create',
  DOC_DELETE: 'doc:delete',
  /** UI helper: native folder picker (returns a path or null; no side effect). */
  DIALOG_PICK_FOLDER: 'dialog:pick-folder',
  /** Query: effective style maps (project `.iris/styles.json` → machine → builtin). */
  STYLES_GET: 'styles:get',
  /** Verb (instruction-backed): write the project-level style maps. */
  STYLES_UPDATE: 'styles:update',
  /** Local performance monitor (in-memory only; no terminal/doc content). */
  PERF_SNAPSHOT: 'perf:snapshot',
  PERF_CLEAR: 'perf:clear',

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

export const EVENTS = {
  SETTINGS_CHANGED: 'evt:settings:changed',
  /** Main → renderer: window is closing, flush unsaved editor work now (B3).
   *  The renderer replies via the APP_FLUSH_DONE channel. */
  APP_FLUSH_BEFORE_QUIT: 'evt:app:flush-before-quit',
  /** Maximize/restore state for the custom title bar's caption button. */
  WINDOW_MAXIMIZED_CHANGED: 'evt:window:maximized-changed',
  /** Batched .iris/ tree changes (chokidar, debounced in main). */
  FS_IRIS_CHANGED: 'evt:fs:iris-changed',
  SESSION_OUTPUT: 'evt:session:output',
  SESSION_STATE_CHANGED: 'evt:session:state-changed',
  SESSION_EXITED: 'evt:session:exited',
  SESSION_DESTROYED: 'evt:session:destroyed',
} as const;
