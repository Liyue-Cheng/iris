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

  'project.init': {
    meta: {
      description:
        'Idempotent protocol scaffold: typed folders + constitution + AGENTS.md guidance',
      category: 'system',
      resourceIdentifier: () => ['project'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.PROJECT_INIT },
    commit: async () => {
      // The watcher may not have been armed on a missing .iris/ — refresh
      // the projection explicitly rather than trusting the fs event.
      await projectStore.rescan();
    },
  },

  'workspace.create': {
    meta: {
      description: 'Create a sub-workspace (standard four folders / empty) — human gesture only',
      category: 'system',
      resourceIdentifier: (p: { parentPath: string }) => [`docdir:${p.parentPath}`],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.WORKSPACE_CREATE },
    commit: async () => {
      await projectStore.rescan();
    },
  },

  'machine.install-conventions': {
    meta: {
      description: 'Write the machine-layer constitution template to ~/.iris/ (never overwrite)',
      category: 'system',
      resourceIdentifier: () => ['machine-conventions'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.MACHINE_INSTALL_CONVENTIONS },
  },
};
