/** Managed companion-asset write instructions. Queries use asset:list directly. */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';
import { projectScopeRead } from './project-resources';

export const assetISA: Record<string, InstructionDefinition> = {
  'asset.import': {
    meta: {
      description: 'Import bytes into a document companion asset directory',
      category: 'task',
      resourceIdentifier: (p: { docPath: string }) => [
        projectScopeRead(),
        `doc:${p.docPath}`,
        `assets:${p.docPath}`,
      ],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 15000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.ASSET_IMPORT, projectScoped: true },
  },

  'asset.trash': {
    meta: {
      description: 'Move an unreferenced managed asset to the system trash',
      category: 'task',
      resourceIdentifier: (p: { docPath: string }) => [
        projectScopeRead(),
        `doc:${p.docPath}`,
        `assets:${p.docPath}`,
      ],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.ASSET_TRASH, projectScoped: true },
  },

  'asset.adopt': {
    meta: {
      description: 'Adopt a legacy local or data-image reference and rewrite its Markdown URL',
      category: 'task',
      resourceIdentifier: (p: { docPath: string }) => [
        projectScopeRead(),
        `doc:${p.docPath}`,
        `assets:${p.docPath}`,
      ],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 15000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.ASSET_ADOPT, projectScoped: true },
  },

  'asset.link-add': {
    meta: {
      description: 'Associate an external file or directory with a document',
      category: 'task',
      resourceIdentifier: (p: { docPath: string }) => [projectScopeRead(), `doc:${p.docPath}`, `assets:${p.docPath}`],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.ASSET_LINK_ADD, projectScoped: true },
  },

  'asset.link-remove': {
    meta: {
      description: 'Remove an external file or directory association',
      category: 'task',
      resourceIdentifier: (p: { docPath: string }) => [projectScopeRead(), `doc:${p.docPath}`, `assets:${p.docPath}`],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.ASSET_LINK_REMOVE, projectScoped: true },
  },
};
