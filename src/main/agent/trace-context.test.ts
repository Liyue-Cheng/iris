import { describe, expect, it } from 'vitest';
import { createEmptyAgentSession } from './session-model';
import { buildAgentContext, buildAgentTrace, diffAnchorText } from './trace-context';
import { truncateIntentChain } from './session-domain';

function sessionWithTurns() {
  const session = createEmptyAgentSession({
    id: 'trace-session',
    anchor: { kind: 'workspace', path: '.iris' },
    model: { provider: 'openai', modelId: 'test' },
    projectRoot: 'E:/project',
    displayName: 'Agent',
    now: 1,
  });
  for (const [index, turnId] of ['turn-1', 'turn-2'].entries()) {
    const userId = `user-${index + 1}`;
    session.turns.push({ id: turnId, userActivityId: userId, state: 'fulfilled', assembledInputAvailable: true, createdAt: index + 1 });
    session.timeline.push({ kind: 'user', id: userId, ordinal: index * 2 + 1, turnId, content: `request ${index + 1}`, assembledInputArtifactId: `input-${index + 1}`, createdAt: index + 1 });
    session.transcript.push({ id: `frame-user-${index + 1}`, turnId, role: 'user', content: `request ${index + 1}`, createdAt: index + 1 });
    session.transcript.push({ id: `frame-assistant-${index + 1}`, turnId, role: 'assistant', providerCallId: `call-${index + 1}`, content: `answer ${index + 1}`, createdAt: index + 2 });
    session.providerCalls.push({ id: `call-${index + 1}`, turnId, index: index + 1, state: 'completed', attemptIds: [], createdAt: index + 1, completedAt: index + 2 });
  }
  session.nextOrdinal = 5;
  session.effectiveTraceLength = 2;
  return session;
}

describe('Agent Trace and Context', () => {
  it('projects a pure turn-level context and respects the effective prefix', () => {
    const session = sessionWithTurns();
    const trace = buildAgentTrace(session);
    expect(trace.turns).toHaveLength(2);
    expect(buildAgentContext(trace).messages.map((message) => message.content)).toEqual([
      'request 1', 'answer 1', 'request 2', 'answer 2',
    ]);
    session.effectiveTraceLength = 1;
    expect(buildAgentContext(buildAgentTrace(session)).messages.map((message) => message.content))
      .toEqual(['request 1', 'answer 1']);
  });

  it('rewinds by truncating the prefix while retaining trace entries', () => {
    const session = sessionWithTurns();
    const rewound = truncateIntentChain(session, 'rewind-1', 4);
    expect(rewound.effectiveTraceLength).toBe(1);
    expect(rewound.turns).toHaveLength(2);
    expect(buildAgentTrace(rewound).turns).toHaveLength(2);
    expect(buildAgentContext(buildAgentTrace(rewound)).messages.map((message) => message.content))
      .toEqual(['request 1', 'answer 1']);
  });

  it('records only changed anchor lines', () => {
    expect(diffAnchorText('a\nb\nc', 'a\nc\nd')).toBe('-b\n+d');
    expect(diffAnchorText('same', 'same')).toBe('');
  });
});

