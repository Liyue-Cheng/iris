/**
 * @file agent-isa.ts
 * @purpose `agent.*` verbs — the context-injection adapter's two writes:
 *   the machine-level focus-context script (~/.iris/, app-owned) and a
 *   SessionStart hook into one agent CLI's own config file (user-owned,
 *   so the UI gates this behind an explicit confirmation; main backs the
 *   file up before writing). Reading the detection state is a projection
 *   and lives in the settings panel, not here.
 */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';

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

  // Prompt governance (issue: iris软件提示词治理): write/refresh the
  // <iris-software> block in one entry file, and upgrade an untouched factory
  // constitution. Both user-confirmed in the settings UI; main writes a .bak.
  'software-prompt.sync-entry': {
    meta: {
      description: 'Write/refresh the <iris-software> block in one entry file (user-confirmed)',
      category: 'system',
      resourceIdentifier: () => ['software-prompt'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.SOFTWARE_PROMPT_SYNC_ENTRY },
  },

  'software-prompt.upgrade-constitution': {
    meta: {
      description: 'Upgrade an untouched factory constitution to the current default (user-confirmed)',
      category: 'system',
      resourceIdentifier: () => ['software-prompt'],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.SOFTWARE_PROMPT_UPGRADE_CONSTITUTION },
  },
};
