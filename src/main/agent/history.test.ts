import { describe, expect, it } from 'vitest';
import {
  completeActiveAgentIntent,
  pauseActiveAgentIntent,
  resumePausedAgentIntent,
  supersedeOpenAgentIntent,
  truncateIntentChain,
} from './session-domain';
import { createEmptyAgentSession, projectAgentSession } from './session-model';
import { createIrisAgentBranch, createIrisAgentInputBranch } from './session-manager';

function runningSession() {
  const session = createEmptyAgentSession({
    id: 'session-1',
    anchor: { kind: 'workspace', path: '.iris' },
    model: { provider: 'openai', modelId: 'gpt-test' },
    projectRoot: 'E:/project',
    displayName: 'Iris Agent',
    injection: {
      methods: { agent: 'current', software: 'current', project: 'current' },
      anchor: { path: '.iris', baselineText: '', baselineSha256: '', capturedAt: 1 },
    },
    now: 1,
  });
  session.state = 'running';
  session.currentIntentId = 'intent-1';
  session.activeIntentIds = ['intent-1'];
  session.intents.push({
    id: 'intent-1', content: 'do it', turnIds: ['turn-1'], state: 'running',
    assembledInputAvailable: true, createdAt: 1,
  });
  session.turns.push({
    id: 'turn-1', intentId: 'intent-1', invokeId: 'invoke-1', state: 'running',
    assistant: null, toolResults: [], createdAt: 1,
  });
  session.invokes.push({
    id: 'invoke-1', intentId: 'intent-1', turnId: 'turn-1', index: 1,
    state: 'running', attemptIds: ['attempt-1'], createdAt: 1,
  });
  session.invokeAttempts.push({
    id: 'attempt-1', invokeId: 'invoke-1', intentId: 'intent-1', turnId: 'turn-1',
    index: 1, state: 'running', createdAt: 1,
  });
  session.timeline.push({
    kind: 'reply', id: 'reply-a', ordinal: 1, intentId: 'intent-1', turnId: 'turn-1',
    invokeId: 'invoke-1', invokeAttemptId: 'attempt-1', providerMessageId: 'message-1',
    state: 'streaming', contextDisposition: 'pending', content: 'partial A', createdAt: 2,
  });
  session.nextOrdinal = 2;
  return session;
}

describe('Iris Agent Intent domain', () => {
  it('pauses an Intent while retaining its partial Reply as excluded evidence', () => {
    const paused = pauseActiveAgentIntent(
      runningSession(), { sessionId: 'session-1', intentId: 'intent-1' },
      'user', 'Paused by user.', 3,
    );
    expect(paused.intents[0]).toMatchObject({ state: 'paused', pauseReason: 'user' });
    expect(paused.timeline[0]).toMatchObject({
      id: 'reply-a', state: 'stopped', content: 'partial A', contextDisposition: 'excluded',
    });
    expect(projectAgentSession(paused, 1).pause?.reason).toBe('user');
  });

  it('resumes and completes the same Intent across multiple execution Turns', () => {
    const resumed = resumePausedAgentIntent(pauseActiveAgentIntent(
      runningSession(), { sessionId: 'session-1', intentId: 'intent-1' },
      'user', 'Paused by user.', 3,
    ));
    resumed.intents[0]!.turnIds.push('turn-2');
    resumed.turns.push({
      id: 'turn-2', intentId: 'intent-1', invokeId: 'invoke-2', state: 'running',
      assistant: { content: 'answer B', toolCalls: [], createdAt: 5 }, toolResults: [], createdAt: 5,
    });
    resumed.invokes.push({
      id: 'invoke-2', intentId: 'intent-1', turnId: 'turn-2', index: 2,
      state: 'completed', attemptIds: [], createdAt: 5, completedAt: 5,
    });
    const completed = completeActiveAgentIntent(
      resumed, { sessionId: 'session-1', intentId: 'intent-1' }, 6,
    );
    expect(completed.intents[0]?.state).toBe('completed');
    expect(completed.intents[0]?.turnIds).toEqual(['turn-1', 'turn-2']);
    expect(projectAgentSession(completed, 1).intents[0]?.state).toBe('completed');
  });

  it('rewinds by truncating the Trace without changing the removed Intent state', () => {
    const completed = completeActiveAgentIntent(
      runningSession(), { sessionId: 'session-1', intentId: 'intent-1' }, 3,
    );
    const rewound = truncateIntentChain(completed);
    expect(rewound.intents[0]?.state).toBe('completed');
    expect(rewound.turns).toHaveLength(1);
    expect(rewound.activeIntentIds).toEqual([]);
    expect(projectAgentSession(rewound, 1).intents).toEqual([]);
  });

  it('restores a superseded predecessor as paused when its successor is rewound', () => {
    const source = runningSession();
    const paused = pauseActiveAgentIntent(
      source, { sessionId: 'session-1', intentId: 'intent-1' }, 'user', 'Paused.', 3,
    );
    paused.intents.push({
      id: 'intent-2', content: 'new direction', turnIds: [], state: 'running',
      assembledInputAvailable: false, createdAt: 4,
    });
    paused.activeIntentIds.push('intent-2');
    paused.intents[0]!.state = 'superseded';
    paused.currentIntentId = 'intent-2';
    paused.state = 'idle';
    const rewound = truncateIntentChain(paused);
    expect(rewound.activeIntentIds).toEqual(['intent-1']);
    expect(rewound.currentIntentId).toBe('intent-1');
    expect(rewound.state).toBe('paused');
    expect(rewound.intents[0]).toMatchObject({ state: 'paused', pauseReason: 'user' });
  });

  it('keeps a held Invoke open on pause and aborts it only when a new input takes over', () => {
    const source = runningSession();
    source.invokeAttempts[0]!.state = 'failed';
    source.invokeAttempts[0]!.completedAt = 2;
    const paused = pauseActiveAgentIntent(
      source, { sessionId: 'session-1', intentId: 'intent-1' }, 'provider', 'Provider unavailable.', 3,
    );
    expect(paused.invokes[0]).toMatchObject({ state: 'holding' });
    expect(paused.invokeAttempts[0]).toMatchObject({ state: 'failed' });

    const superseded = supersedeOpenAgentIntent(paused, 4);
    expect(superseded.intents[0]?.state).toBe('superseded');
    expect(superseded.invokes[0]).toMatchObject({ state: 'aborted', completedAt: 4 });
  });

  it('branches with a closed reference graph and resets only the selected input execution', () => {
    const source = runningSession();
    source.turns[0]!.assistant = { content: 'done', toolCalls: [], createdAt: 3 };
    source.invokes[0]!.state = 'completed';
    source.invokes[0]!.completedAt = 3;
    source.invokeAttempts[0]!.state = 'completed';
    source.invokeAttempts[0]!.completedAt = 3;
    const completed = completeActiveAgentIntent(
      source, { sessionId: 'session-1', intentId: 'intent-1' }, 3,
    );

    const branch = createIrisAgentBranch(completed, 'intent-1', 'branch', 'Branch', 4);
    expect(branch.activeIntentIds).toEqual(['intent-1']);
    expect(branch.turns).toHaveLength(1);
    expect(branch.invokes[0]).toMatchObject({ turnId: branch.turns[0]?.id });
    expect(branch.invokeAttempts[0]).toMatchObject({ turnId: branch.turns[0]?.id });

    const inputBranch = createIrisAgentInputBranch(
      completed, 'intent-1', 'input-branch', 'Input Branch', 4,
    );
    expect(inputBranch.activeIntentIds).toEqual(['intent-1']);
    expect(inputBranch.currentIntentId).toBe('intent-1');
    expect(inputBranch.intents[0]).toMatchObject({ state: 'paused', turnIds: [] });
    expect(inputBranch.turns).toEqual([]);
    expect(inputBranch.invokes).toEqual([]);
  });

  it('allows an Input Fork from a superseded Intent without changing the source', () => {
    const source = runningSession();
    source.state = 'idle';
    source.currentIntentId = null;
    source.intents[0]!.state = 'superseded';
    const branch = createIrisAgentInputBranch(source, 'intent-1', 'input-branch', 'Input Branch', 4);
    expect(source.intents[0]?.state).toBe('superseded');
    expect(branch.intents[0]).toMatchObject({ state: 'paused', turnIds: [] });
    expect(branch.currentIntentId).toBe('intent-1');
  });
});
