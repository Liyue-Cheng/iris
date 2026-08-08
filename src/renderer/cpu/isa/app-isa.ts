/**
 * @file app-isa.ts
 * @purpose `app.*` instructions — application-level plumbing.
 *
 * M0: `app.ping` proves the whole chain (dispatch → SCH → ipc executor →
 * preload bridge → ipcMain handler → back). It stays after M0 as the
 * debug-panel health check.
 */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';
import { projectScopeRead } from './project-resources';

export const appISA: Record<string, InstructionDefinition> = {
  'app.ping': {
    meta: {
      description: 'Round-trip ping through the main process (pipeline health check)',
      category: 'debug',
      // No resources: pings never conflict with anything.
      resourceIdentifier: () => [],
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.APP_PING },
  },

  'shell.reveal-project-item': {
    meta: {
      description: 'Reveal a project-relative item in the system file manager',
      category: 'system',
      resourceIdentifier: () => [projectScopeRead()],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.SHELL_REVEAL, projectScoped: true },
  },

  'shell.open-project-item': {
    meta: {
      description: 'Open a project-relative item with the system default application',
      category: 'system',
      resourceIdentifier: () => [projectScopeRead()],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.SHELL_OPEN_PATH, projectScoped: true },
  },

  'shell.reveal-path': {
    meta: {
      description: 'Reveal an absolute machine path in the system file manager',
      category: 'system',
      resourceIdentifier: () => ['system-file-manager'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.SHELL_REVEAL },
  },
};
