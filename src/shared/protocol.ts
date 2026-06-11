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
} as const;

export const EVENTS = {
  SETTINGS_CHANGED: 'evt:settings:changed',
} as const;
