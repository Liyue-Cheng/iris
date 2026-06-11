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
};
