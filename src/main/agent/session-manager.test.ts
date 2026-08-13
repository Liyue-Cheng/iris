import { describe, expect, it } from 'vitest';
import { applyIrisAgentMessageRewind } from './session-manager';
import type { IrisAgentSessionInfo } from '@shared/types';

const baseSession: IrisAgentSessionInfo = {
  id: 'agent-1',
  kind: 'iris-agent',
  anchor: { kind: 'document', path: '.iris/issue/task.md' },
  projectRoot: 'E:/project',
  projectGeneration: 1,
  displayName: 'Iris Agent',
  state: 'idle',
  createdAt: 1,
  updatedAt: 1,
  activeTurnId: null,
  messages: [
    { id: 'u1', turnId: 'turn-1', role: 'user', content: 'one', createdAt: 1 },
    { id: 'a1', turnId: 'turn-1', role: 'assistant', content: 'done one', createdAt: 2 },
    { id: 'u2', turnId: 'turn-2', role: 'user', content: 'two', createdAt: 3 },
    { id: 'a2', turnId: 'turn-2', role: 'assistant', content: 'done two', createdAt: 4 },
  ],
  turns: [
    {
      id: 'turn-1',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      requestId: 'request-1',
      status: 'completed',
      createdAt: 1,
      completedAt: 2,
    },
    {
      id: 'turn-2',
      userMessageId: 'u2',
      assistantMessageId: 'a2',
      requestId: 'request-2',
      status: 'completed',
      createdAt: 3,
      completedAt: 4,
    },
  ],
  toolEvents: [
    {
      id: 'tool-2',
      turnId: 'turn-2',
      requestId: 'request-2',
      name: 'read',
      state: 'completed',
      createdAt: 3,
      inputSummary: 'read src/file.ts',
    },
  ],
  fileEffects: [
    {
      id: 'effect-2',
      turnId: 'turn-2',
      toolCallId: 'tool-2',
      path: 'src/file.ts',
      kind: 'edit',
      beforeSha256: 'before',
      afterSha256: 'after',
      beforeContent: 'before',
      afterContent: 'after',
      createdAt: 3,
    },
  ],
  requestFacts: [
    {
      id: 'request-1',
      turnId: 'turn-1',
      createdAt: 1,
      promptFingerprint: 'prompt-1',
      layerFingerprints: { agent: 'g1', software: 's1', project: 'p1', anchor: 'a1' },
      anchor: { kind: 'document', path: '.iris/issue/task.md' },
      promptChars: 100,
      redacted: true,
    },
    {
      id: 'request-2',
      turnId: 'turn-2',
      createdAt: 3,
      promptFingerprint: 'prompt-2',
      layerFingerprints: { agent: 'g2', software: 's2', project: 'p2', anchor: 'a2' },
      anchor: { kind: 'document', path: '.iris/issue/task.md' },
      promptChars: 120,
      redacted: true,
    },
  ],
  selfHostingEligible: false,
};

describe('IrisAgentSessionManager rewind', () => {
  it('keeps the completed target turn and removes only later local history', () => {
    const rewound = applyIrisAgentMessageRewind(baseSession, 'turn-1');

    expect(rewound.turns.map((turn) => turn.id)).toEqual(['turn-1']);
    expect(rewound.messages.map((message) => message.id)).toEqual(['u1', 'a1']);
    expect(rewound.toolEvents).toEqual([]);
    expect(rewound.fileEffects).toEqual([]);
    expect(rewound.requestFacts.map((facts) => facts.id)).toEqual(['request-1']);
    expect(rewound.state).toBe('idle');
  });

  it('rejects incomplete rewind targets', () => {
    const running = {
      ...baseSession,
      turns: [...baseSession.turns, {
        id: 'turn-3',
        userMessageId: 'u3',
        requestId: 'request-3',
        status: 'running' as const,
        createdAt: 5,
      }],
    };

    expect(() => applyIrisAgentMessageRewind(running, 'turn-3')).toThrow(/completed/);
  });
});
