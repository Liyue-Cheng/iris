/**
 * @file project-isa.ts
 * @purpose `project.*` instructions. Opening a project is a verb (it starts
 *   watchers, persists lastRoot) → instruction. Scanning/reading are
 *   projection queries and deliberately NOT instructions (CQRS boundary).
 */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';
import type { IrisScanResult } from '@shared/types';
import { projectStore } from '@renderer/stores/project-store';

export const projectISA: Record<string, InstructionDefinition> = {
  'project.open': {
    meta: {
      description: 'Open a project folder, start watching .iris/, persist lastRoot',
      category: 'system',
      // One project at a time: opens serialize on the singleton resource.
      resourceIdentifier: () => ['project'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 15000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.PROJECT_OPEN },
    commit: async (result: IrisScanResult) => {
      projectStore.handleOpened(result);
    },
  },
};
