/**
 * @file git-isa.ts
 * @purpose Git write verbs. Reading the current Git snapshot is a projection
 * query and stays in git-store; operations that mutate the repository go
 * through the FrontCPU pipeline so they share one serial resource lock.
 */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';
import { projectScopeRead } from './project-resources';

const repositoryResource = (): Array<string | { id: string; mode: 'read' }> => [
  projectScopeRead(),
  'git:repository',
];

export const gitISA: Record<string, InstructionDefinition> = {
  'git.stage': {
    meta: {
      description: 'Stage one or more repository paths',
      category: 'task',
      resourceIdentifier: repositoryResource,
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 45000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.GIT_STAGE, projectScoped: true },
  },

  'git.unstage': {
    meta: {
      description: 'Unstage one or more repository paths',
      category: 'task',
      resourceIdentifier: repositoryResource,
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 45000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.GIT_UNSTAGE, projectScoped: true },
  },

  'git.commit': {
    meta: {
      description: 'Commit the staged repository changes with the native Git configuration',
      category: 'task',
      resourceIdentifier: repositoryResource,
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 330000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.GIT_COMMIT, projectScoped: true },
  },

  'git.switch-branch': {
    meta: {
      description: 'Switch to a local Git branch',
      category: 'task',
      resourceIdentifier: repositoryResource,
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 75000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.GIT_SWITCH_BRANCH, projectScoped: true },
  },
};
