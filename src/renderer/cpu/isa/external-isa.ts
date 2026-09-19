import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';
import { projectScopeRead } from './project-resources';

export const externalISA: Record<string, InstructionDefinition> = {
  'external.add': {
    meta: {
      description: 'Add a file or directory reference to workspace external.txt',
      category: 'task',
      resourceIdentifier: (p: { workspacePath: string }) => [
        projectScopeRead(),
        `external:${p.workspacePath}`,
      ],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.EXTERNAL_ADD, projectScoped: true },
  },
  'external.remove': {
    meta: {
      description: 'Remove a workspace external.txt reference without deleting its target',
      category: 'task',
      resourceIdentifier: (p: { workspacePath: string }) => [
        projectScopeRead(),
        `external:${p.workspacePath}`,
      ],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.EXTERNAL_REMOVE, projectScoped: true },
  },
};
