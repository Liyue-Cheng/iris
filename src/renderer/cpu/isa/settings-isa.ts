/**
 * @file settings-isa.ts
 * @purpose `settings.*` instructions. Settings mutation is a side effect, so
 *   it goes through the pipeline (CQRS: ISA owns the verbs that change the
 *   world). Reading settings is a projection and does NOT live here — the
 *   settings store loads via the bridge and listens to the
 *   evt:settings:changed broadcast.
 */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';

export const settingsISA: Record<string, InstructionDefinition> = {
  'settings.update': {
    meta: {
      description: 'Apply a partial settings update (validated and persisted by main)',
      category: 'system',
      // Single logical resource: concurrent updates serialize so last-write-
      // wins is deterministic.
      resourceIdentifier: () => ['settings'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.SETTINGS_UPDATE },
  },
};
