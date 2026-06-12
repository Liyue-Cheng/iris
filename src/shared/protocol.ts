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
  /** Queries (projection reads — not instructions). */
  PROJECT_SCAN: 'project:scan',
  PROJECT_RAW_TREE: 'project:raw-tree',
  DOC_READ: 'doc:read',
  /** Verbs (instruction-backed): write a doc verbatim / create a typed doc. */
  DOC_WRITE: 'doc:write',
  DOC_CREATE: 'doc:create',
  /** UI helper: native folder picker (returns a path or null; no side effect). */
  DIALOG_PICK_FOLDER: 'dialog:pick-folder',

  /** Session verbs (instruction-backed). */
  SESSION_OPEN: 'session:open',
  SESSION_CLOSE: 'session:close',
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
  /** Maximize/restore state for the custom title bar's caption button. */
  WINDOW_MAXIMIZED_CHANGED: 'evt:window:maximized-changed',
  /** Batched .iris/ tree changes (chokidar, debounced in main). */
  FS_IRIS_CHANGED: 'evt:fs:iris-changed',
  SESSION_OUTPUT: 'evt:session:output',
  SESSION_STATE_CHANGED: 'evt:session:state-changed',
  SESSION_EXITED: 'evt:session:exited',
  SESSION_DESTROYED: 'evt:session:destroyed',
} as const;
