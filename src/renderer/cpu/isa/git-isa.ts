/**
 * @file git-isa.ts
 * @purpose Git write verbs. Reading the current Git snapshot is a projection
 * query and stays in git-store; operations that mutate the repository go
 * through the FrontCPU pipeline so they share one serial resource lock.
 */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';

const repositoryResource = (): string[] => ['git:repository'];

export const gitISA: Record<string, InstructionDefinition> = {
  'git.stage': {
    meta: {
      description: 'Stage one or more repository paths',
      category: 'task',
      resourceIdentifier: repositoryResource,
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.GIT_STAGE },
  },

  'git.unstage': {
    meta: {
      description: 'Unstage one or more repository paths',
      category: 'task',
      resourceIdentifier: repositoryResource,
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.GIT_UNSTAGE },
  },

  'git.commit': {
    meta: {
      description: 'Commit the staged repository changes with the native Git configuration',
      category: 'task',
      resourceIdentifier: repositoryResource,
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 15000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.GIT_COMMIT },
  },

  'git.switch-branch': {
    meta: {
      description: 'Switch to a local Git branch',
      category: 'task',
      resourceIdentifier: repositoryResource,
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.GIT_SWITCH_BRANCH },
  },
};
