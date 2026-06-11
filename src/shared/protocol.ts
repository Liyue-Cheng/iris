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
  /** Queries (projection reads — not instructions). */
  PROJECT_SCAN: 'project:scan',
  PROJECT_RAW_TREE: 'project:raw-tree',
  DOC_READ: 'doc:read',
  /** Verbs (instruction-backed): write a doc verbatim / create a typed doc. */
  DOC_WRITE: 'doc:write',
  DOC_CREATE: 'doc:create',
  /** UI helper: native folder picker (returns a path or null; no side effect). */
  DIALOG_PICK_FOLDER: 'dialog:pick-folder',
} as const;

export const EVENTS = {
  SETTINGS_CHANGED: 'evt:settings:changed',
  /** Batched .iris/ tree changes (chokidar, debounced in main). */
  FS_IRIS_CHANGED: 'evt:fs:iris-changed',
} as const;
