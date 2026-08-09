/**
 * @file agent-isa.ts
 * @purpose `agent.*` verbs — maintain the machine-level focus-context script
 *   (~/.iris/, app-owned), and add/remove Iris's SessionStart handler in one
 *   agent CLI's own config file (user-owned, so the UI gates these writes
 *   behind explicit confirmation). Reading the detection state is a projection
 *   and lives in the settings panel, not here.
 */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';
import type { ProjectPromptUpdateResult } from '@shared/types';
import { projectSettingsStore } from '@renderer/stores/project-settings-store';
import { projectScopeRead } from './project-resources';

export const agentISA: Record<string, InstructionDefinition> = {
  'agent.install-focus-script': {
    meta: {
      description: 'Write/refresh the machine-level focus-context script (~/.iris)',
      category: 'system',
      resourceIdentifier: () => ['agent-injection'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.AGENT_INSTALL_FOCUS_SCRIPT },
  },

  'agent.install-hook': {
    meta: {
      description: 'Write the SessionStart hook into one agent CLI config (user-confirmed)',
      category: 'system',
      resourceIdentifier: () => ['agent-injection'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.AGENT_INSTALL_HOOK },
  },

  'agent.remove-hook': {
    meta: {
      description: 'Remove only the Iris SessionStart handler from one agent CLI config',
      category: 'system',
      resourceIdentifier: () => ['agent-injection'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.AGENT_REMOVE_HOOK },
  },

  // Prompt governance: software restoration is confirmation-gated; project
  // prompt saves are explicit user edits and fan out to every entry.
  'software-prompt.sync-entry': {
    meta: {
      description: 'Write/refresh the <iris-software> block in one entry file (user-confirmed)',
      category: 'system',
      resourceIdentifier: () => [projectScopeRead(), 'software-prompt'],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.SOFTWARE_PROMPT_SYNC_ENTRY, projectScoped: true },
  },

  'prompt.sync-all': {
    meta: {
      description: 'Reconcile both prompt layers in every participating entry file',
      category: 'system',
      resourceIdentifier: () => [projectScopeRead(), 'software-prompt'],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.PROMPT_SYNC_ALL, projectScoped: true },
  },

  'prompt.entry-add': {
    meta: {
      description: 'Enroll an entry file and project both prompt layers into it',
      category: 'system',
      resourceIdentifier: () => [projectScopeRead(), 'software-prompt'],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.PROMPT_ENTRY_ADD, projectScoped: true },
    commit: async (result: ProjectPromptUpdateResult) => {
      projectSettingsStore.handleSnapshot(result.snapshot);
    },
  },

  'prompt.entry-remove': {
    meta: {
      description: 'Remove both managed blocks and detach an entry file',
      category: 'system',
      resourceIdentifier: () => [projectScopeRead(), 'software-prompt'],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 10000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.PROMPT_ENTRY_REMOVE, projectScoped: true },
    commit: async (result: ProjectPromptUpdateResult) => {
      projectSettingsStore.handleSnapshot(result.snapshot);
    },
  },

  'project-prompt.sync': {
    meta: {
      description: 'Save and synchronize the optional <iris-project> block',
      category: 'system',
      resourceIdentifier: () => [projectScopeRead(), 'software-prompt'],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.PROJECT_PROMPT_SYNC, projectScoped: true },
    commit: async (result: ProjectPromptUpdateResult) => {
      projectSettingsStore.handleSnapshot(result.snapshot);
    },
  },

  'project-prompt.restore-entry': {
    meta: {
      description: 'Restore one <iris-project> mirror from project settings',
      category: 'system',
      resourceIdentifier: () => [projectScopeRead(), 'software-prompt'],
      schedulingStrategy: 'read-write',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.PROJECT_PROMPT_RESTORE_ENTRY, projectScoped: true },
  },
};
