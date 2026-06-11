/**
 * @file session-isa.ts
 * @purpose `session.*` verbs. Opening spawns a PTY with FOCUS_DOC injected
 *   (the core gesture); closing kills and removes it.
 *
 * Streaming I/O (keystrokes / resize / output) is deliberately NOT here —
 * it's continuous interaction, not discrete verbs (documented CQRS
 * deviation in shared/protocol.ts).
 */
import type { InstructionDefinition } from 'front-cpu';
import { CHANNELS } from '@shared/protocol';
import type { SessionInfo } from '@shared/types';
import { sessionStore } from '@renderer/stores/session-store';

export const sessionISA: Record<string, InstructionDefinition> = {
  'session.open': {
    meta: {
      description: 'Spawn an agent session (PTY at project root, FOCUS_DOC injected, bare launch)',
      category: 'system',
      // Spawns don't conflict with each other or anything else.
      resourceIdentifier: () => [],
      priority: 5,
      timeout: 15000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.SESSION_OPEN },
    commit: async (result: SessionInfo) => {
      sessionStore.handleCreated(result);
    },
  },

  'session.close': {
    meta: {
      description: 'Close and destroy a session (scrollback is discarded)',
      category: 'system',
      resourceIdentifier: (p: { sessionId: string }) => [`session:${p.sessionId}`],
      schedulingStrategy: 'serial',
      priority: 5,
      timeout: 5000,
    },
    executor: 'ipc',
    config: { channel: CHANNELS.SESSION_CLOSE },
    commit: async (_result: unknown, payload: { sessionId: string }) => {
      sessionStore.handleDestroyed(payload.sessionId);
    },
  },
};
