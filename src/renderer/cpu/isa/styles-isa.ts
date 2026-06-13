/**
 * @file styles-isa.ts
 * @purpose `styles.*` instructions — writing the project-level style tables
 *   (`.iris/styles.json`) is a world-changing verb, so it goes through the
 *   pipeline. Reading the effective maps is a projection (styles-store).
 */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';
import type { StyleMapsState } from '@shared/style-maps';
import { stylesStore } from '@renderer/stores/styles-store';

export const stylesISA: Record<string, InstructionDefinition> = {
  'styles.update': {
    meta: {
      description: 'Write the project-level status/label style tables',
      category: 'system',
      // One logical file → serialize so last-write-wins is deterministic.
      resourceIdentifier: () => ['styles'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.STYLES_UPDATE },
    commit: async (result) => {
      stylesStore.handleUpdated(result as StyleMapsState);
    },
  },
};
