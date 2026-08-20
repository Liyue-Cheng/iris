import { describe, expect, it } from 'vitest';
import {
  completeActiveAgentTurn,
  pauseActiveAgentTurn,
  resumePausedAgentTurn,
  undoLatestIrisAgentTurn,
} from './session-domain';
import { createEmptyAgentSession, projectAgentSession } from './session-model';

function runningSession() {
  const session = createEmptyAgentSession({
    id: 'session-1',
    anchor: { kind: 'workspace', path: '.iris' },
    model: { provider: 'openai', modelId: 'gpt-test' },
    projectRoot: 'E:/project',
    displayName: 'Iris Agent',
    now: 1,
  });
  session.state = 'running';
  session.currentTurnId = 'turn-1';
  session.turns.push({
    id: 'turn-1', userActivityId: 'user-1', state: 'running',
    assembledInputAvailable: true, createdAt: 1,
  });
  session.timeline.push(
    {
      kind: 'user', id: 'user-1', ordinal: 1, turnId: 'turn-1', content: 'do it',
      assembledInputArtifactId: 'input-1', createdAt: 1,
    },
    {
      kind: 'reply', id: 'reply-a', ordinal: 2, turnId: 'turn-1',
      providerCallId: 'call-1', providerAttemptId: 'attempt-1', providerMessageId: 'message-1',
      state: 'streaming', contextDisposition: 'pending', content: 'partial A', createdAt: 2,
    },
  );
  session.nextOrdinal = 3;
  return session;
}

describe('Iris Agent Turn domain', () => {
  it('pauses the Turn without deleting the partial Reply', () => {
    const paused = pauseActiveAgentTurn(
      runningSession(),
      { sessionId: 'session-1', turnId: 'turn-1' },
      'user',
      'Paused by user.',
      3,
    );
    expect(paused.turns[0]).toMatchObject({ state: 'paused', pauseReason: 'user' });
    expect(paused.timeline[1]).toMatchObject({
      id: 'reply-a', state: 'stopped', content: 'partial A', contextDisposition: 'excluded',
    });
    expect(projectAgentSession(paused, 1).pause?.reason).toBe('user');
  });

  it('resumes the same Turn and preserves Reply A before Reply B', () => {
    const paused = pauseActiveAgentTurn(
      runningSession(),
      { sessionId: 'session-1', turnId: 'turn-1' },
      'user',
      'Paused by user.',
      3,
    );
    const resumed = resumePausedAgentTurn(paused);
    resumed.timeline.push({
      kind: 'reply', id: 'reply-b', ordinal: 3, turnId: 'turn-1',
      providerCallId: 'call-2', providerAttemptId: 'attempt-2', providerMessageId: 'message-2',
      state: 'streaming', contextDisposition: 'pending', content: 'answer B', createdAt: 5,
    });
    const completed = completeActiveAgentTurn(
      resumed,
      { sessionId: 'session-1', turnId: 'turn-1' },
      6,
    );
    expect(completed.turns[0]?.state).toBe('fulfilled');
    expect(completed.timeline.map((activity) => activity.id)).toEqual(['user-1', 'reply-a', 'reply-b']);
    expect(completed.timeline[2]).toMatchObject({ state: 'completed', contextDisposition: 'committed' });
    expect(projectAgentSession(completed, 1).turns[0]?.cards.map((card) => card.id)).toEqual([
      'reply-a', 'reply-b',
    ]);
  });

  it('undoes conversation state while retaining the effect ledger', () => {
    const completed = completeActiveAgentTurn(
      runningSession(),
      { sessionId: 'session-1', turnId: 'turn-1' },
      3,
    );
    completed.effects.push({
      id: 'effect-1', kind: 'file-write', turnId: 'turn-1',
      toolActivityId: 'tool-1', path: 'src/a.ts', operation: 'edit', beforeSha256: 'a',
      afterSha256: 'b', artifactRef: 'effects/effect-1.json', createdAt: 2,
    });
    const undone = undoLatestIrisAgentTurn(completed, 'command-1', 4);
    expect(undone.turns[0]?.state).toBe('removed');
    expect(undone.effects).toHaveLength(1);
    expect(projectAgentSession(undone, 1).turns).toEqual([]);
  });
});
