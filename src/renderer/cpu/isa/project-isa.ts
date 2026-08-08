/**
 * @file project-isa.ts
 * @purpose `project.*` instructions. Opening a project is a verb (it starts
 *   watchers, persists lastRoot) → instruction. Scanning/reading are
 *   projection queries and deliberately NOT instructions (CQRS boundary).
 */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';
import type { ProjectOpenResult } from '@shared/types';
import { projectStore } from '@renderer/stores/project-store';
import { sessionStore } from '@renderer/stores/session-store';
import { sameProjectScope } from '@renderer/stores/project-scope-state';
import { projectScopeRead, projectScopeWrite } from './project-resources';

export const projectISA: Record<string, InstructionDefinition> = {
  'project.open': {
    meta: {
      description: 'Open a project folder, start watching .iris/, persist lastRoot',
      category: 'system',
      // One project at a time: opens serialize on the singleton resource.
      resourceIdentifier: () => [projectScopeWrite(), 'settings:projects'],
      schedulingStrategy: 'read-write',
      priority: 5,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.PROJECT_OPEN, projectScoped: true },
    commit: async (result: ProjectOpenResult) => {
      const idempotent = sameProjectScope(projectStore.get().scope, result.scope);
      projectStore.handleOpened(result);
      if (!idempotent) sessionStore.reset(result.sessions, result.scope);
    },
  },

  'window.open-project': {
    meta: {
      description: 'Create a new project window and bind its requested root',
      category: 'system',
      resourceIdentifier: () => ['window-registry', 'settings:projects'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.WINDOW_OPEN_PROJECT },
  },

  'project.recent-remove': {
    meta: {
      description: 'Forget one project from the welcome page recent list',
      category: 'system',
      resourceIdentifier: () => ['settings:recent-projects'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.PROJECT_RECENT_REMOVE },
  },

  'project.init': {
    meta: {
      description:
        'Idempotent protocol scaffold: typed folders + AGENTS.md software guidance',
      category: 'system',
      resourceIdentifier: () => [projectScopeRead(), 'project:structure'],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.PROJECT_INIT, projectScoped: true },
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
      resourceIdentifier: (p: { parentPath: string }) => [
        projectScopeRead(),
        `docdir:${p.parentPath}`,
      ],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.WORKSPACE_CREATE, projectScoped: true },
    commit: async () => {
      await projectStore.rescan();
    },
  },
};
