import { describe, expect, it } from 'vitest';
import type { IrisAgentSessionInfo } from '@shared/types';
import {
  assertIrisAgentExpectedRevision,
  matchesActiveIrisAgentTurn,
  settleIrisAgentTurnDomain,
  undoLatestIrisAgentTurn,
} from './history';

function session(status: 'running' | 'completed' | 'stopped' | 'failed'): IrisAgentSessionInfo {
  return {
    id: 'session-1',
    kind: 'iris-agent',
    anchor: { kind: 'workspace', path: '.iris' },
    model: { provider: 'openai', modelId: 'gpt-test' },
    projectRoot: 'E:/project',
    projectGeneration: 1,
    displayName: 'Iris Agent',
    state: status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'idle',
    createdAt: 1,
    updatedAt: 1,
    revision: 7,
    workerEpoch: 3,
    activeTurnId: status === 'running' ? 'turn-2' : null,
    messages: [
      { id: 'u1', turnId: 'turn-1', role: 'user', content: 'one', createdAt: 1 },
      { id: 'a1', turnId: 'turn-1', role: 'assistant', content: 'answer one', createdAt: 2 },
      { id: 'u2', turnId: 'turn-2', role: 'user', content: 'two', createdAt: 3 },
      { id: 'a2', turnId: 'turn-2', role: 'assistant', content: 'answer two', createdAt: 4 },
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
        status,
        createdAt: 3,
        ...(status === 'running' ? {} : { completedAt: 4 }),
      },
    ],
    toolEvents: [],
    fileEffects: [{
      id: 'effect-2',
      turnId: 'turn-2',
      toolCallId: 'tool-2',
      path: 'src/file.ts',
      kind: 'edit',
      beforeSha256: 'before',
      afterSha256: 'after',
      afterContent: 'changed',
      createdAt: 4,
    }],
    requestFacts: [],
    selfHostingEligible: false,
  };
}

describe('Iris Agent Turn domain', () => {
  it.each(['completed', 'stopped', 'failed'] as const)(
    'undoes exactly one latest %s turn while retaining effect facts',
    (status) => {
      const undone = undoLatestIrisAgentTurn(session(status));
      expect(undone.turns.map((turn) => turn.id)).toEqual(['turn-1']);
      expect(undone.messages.map((message) => message.id)).toEqual(['u1', 'a1']);
      expect(undone.fileEffects).toHaveLength(1);
      expect(undone.pendingArtifactCleanupTurnIds).toEqual(['turn-2']);
    },
  );

  it('rejects a stale revision and stale Worker epoch', () => {
    const running = session('running');
    expect(() => assertIrisAgentExpectedRevision(running, 6)).toThrow(/expected revision 6/);
    expect(matchesActiveIrisAgentTurn(running, {
      sessionId: running.id,
      workerEpoch: 2,
      requestId: 'request-2',
      turnId: 'turn-2',
    })).toBe(false);
  });

  it('gives a persisted stop intent priority over a normal settlement', () => {
    const running = { ...session('running'), stopRequestedTurnId: 'turn-2' };
    const settled = settleIrisAgentTurnDomain(running, {
      sessionId: running.id,
      workerEpoch: running.workerEpoch,
      requestId: 'request-2',
      turnId: 'turn-2',
    }, 'completed');
    expect(settled.turns[1]?.status).toBe('stopped');
  });
});
