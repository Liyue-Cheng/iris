import { describe, expect, it } from 'vitest';
import { createEmptyAgentSession } from './session-model';
import { buildAgentContext, buildAgentTrace, diffAnchorText } from './trace-context';
import { truncateIntentChain } from './session-domain';

function sessionWithIntents() {
  const session = createEmptyAgentSession({
    id: 'trace-session',
    anchor: { kind: 'workspace', path: '.iris' },
    model: { provider: 'openai', modelId: 'test' },
    projectRoot: 'E:/project',
    displayName: 'Agent',
    injection: {
      methods: { agent: 'current', software: 'current', project: 'current' },
      anchor: { path: '.iris', baselineText: '', baselineSha256: '', capturedAt: 1 },
    },
    now: 1,
  });
  for (const [index, intentId] of ['intent-1', 'intent-2'].entries()) {
    const turnId = `turn-${index + 1}`;
    const invokeId = `invoke-${index + 1}`;
    session.intents.push({
      id: intentId,
      content: `request ${index + 1}`,
      turnIds: [turnId],
      state: 'completed',
      assembledInputAvailable: true,
      createdAt: index + 1,
      closedAt: index + 2,
    });
    session.turns.push({
      id: turnId,
      intentId,
      invokeId,
      state: 'settled',
      assistant: {
        content: `answer ${index + 1}`,
        toolCalls: [],
        createdAt: index + 2,
      },
      toolResults: [],
      createdAt: index + 1,
      settledAt: index + 2,
    });
    session.invokes.push({
      id: invokeId,
      intentId,
      turnId,
      index: index + 1,
      state: 'completed',
      attemptIds: [],
      createdAt: index + 1,
      completedAt: index + 2,
    });
    session.activeIntentIds.push(intentId);
  }
  return session;
}

describe('Agent Trace and Context', () => {
  it('projects provider-neutral Context as a pure function of active Trace', () => {
    const trace = buildAgentTrace(sessionWithIntents());
    expect(trace.intents).toHaveLength(2);
    expect(buildAgentContext(trace).messages.map((message) => message.content)).toEqual([
      'request 1', 'answer 1', 'request 2', 'answer 2',
    ]);
    expect(buildAgentContext(trace).messages.every((message) => !('providerMessage' in message))).toBe(true);
  });

  it('rewinds the explicit path and permits a new sibling Intent', () => {
    const rewound = truncateIntentChain(sessionWithIntents(), 'rewind-1', 4);
    rewound.intents.push({
      id: 'intent-3', content: 'request 3', turnIds: [], state: 'running',
      assembledInputAvailable: false, createdAt: 5,
    });
    rewound.activeIntentIds.push('intent-3');
    rewound.currentIntentId = 'intent-3';
    rewound.state = 'running';

    expect(rewound.activeIntentIds).toEqual(['intent-1', 'intent-3']);
    expect(rewound.intents.find((intent) => intent.id === 'intent-2')?.state).toBe('superseded');
    expect(buildAgentContext(buildAgentTrace(rewound)).messages.map((message) => message.content))
      .toEqual(['request 1', 'answer 1']);
  });

  it('synthesizes an interrupted tool result only during Context projection', () => {
    const session = sessionWithIntents();
    const turn = session.turns[0]!;
    turn.assistant!.toolCalls = [{ id: 'tool-1', tool: 'read', input: { path: 'a.ts' } }];
    turn.toolResults = [];
    const context = buildAgentContext(buildAgentTrace(session));
    expect(turn.toolResults).toEqual([]);
    expect(context.messages.at(2)).toMatchObject({
      role: 'tool', toolCallId: 'tool-1', isError: true,
    });
  });

  it('preserves line order and duplicates in anchor patches', () => {
    expect(diffAnchorText('a\nb\nb\nc', 'a\nb\nc\nd')).toEqual([
      { start: 2, deleteCount: 2, lines: ['c', 'd'] },
    ]);
    expect(diffAnchorText('same', 'same')).toEqual([]);
  });
});
