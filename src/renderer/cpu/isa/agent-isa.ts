/**
 * @file agent-isa.ts
 * @purpose `agent.*` verbs — the context-injection adapter's two writes:
 *   the machine-level focus-context script (~/.iris/, app-owned) and a
 *   SessionStart hook into one agent CLI's own config file (user-owned,
 *   so the UI gates this behind an explicit confirmation). Reading the
 *   detection state is a projection
 *   and lives in the settings panel, not here.
 */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';
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
  },
};
