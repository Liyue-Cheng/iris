import { describe, expect, it } from 'vitest';
import { createEmptyAgentSession, normalizeAgentSessionAggregate, projectAgentSession, type AgentToolActivity } from './session-model';
import { assertIrisAgentCloseAllowed, assertIrisAgentExpectedRevision } from './session-domain';

const injection = {
  methods: { agent: 'current' as const, software: 'current' as const, project: 'current' as const },
  anchor: { path: '.iris', baselineText: '', baselineSha256: '', capturedAt: 1 },
};

function terminalActivity(overrides: Partial<AgentToolActivity>): AgentToolActivity {
  return {
    kind: 'tool',
    id: 'tool-terminal',
    ordinal: 1,
    intentId: 'turn-1',
    turnId: 'execution-turn-1',
    invokeId: 'provider-1',
    toolCallId: 'tool-terminal',
    tool: 'terminal',
    intent: 'operation',
    state: 'running',
    inputSummary: 'terminal command',
    operation: 'exec',
    command: 'terminal command',
    cwd: '.',

    createdAt: 1,
    ...overrides,
  };
}

describe('Iris Agent terminal projection', () => {
  it('requires explicit confirmation when closing a busy session', () => {
    const session = createEmptyAgentSession({
      id: 'close-gate',
      anchor: { kind: 'workspace', path: '.iris' },
      model: { provider: 'openai', modelId: 'gpt-test' },
      projectRoot: process.cwd(),
      displayName: 'Iris Agent',
      injection,
      now: 1,
    });
    session.state = 'running';
    expect(() => assertIrisAgentCloseAllowed(session)).toThrowError('requires explicit confirmation');
    expect(() => assertIrisAgentCloseAllowed(session, true)).not.toThrow();
    expect(() => assertIrisAgentExpectedRevision(session, session.revision - 1))
      .toThrowError('changed before this command was applied');
  });

  it('keeps short completed terminals available without marking them revealed', () => {
    const session = createEmptyAgentSession({
      id: 'session-1',
      anchor: { kind: 'workspace', path: '.iris' },
      model: { provider: 'openai', modelId: 'gpt-test' },
      projectRoot: process.cwd(),
      displayName: 'Iris Agent',
      injection,
      now: 1,
    });
    session.timeline.push(terminalActivity({
      state: 'failed',
      terminalId: 'terminal-short',

      terminalState: 'exited',
      terminalOutcome: 'command-failed',
      terminalStartedAt: 2,
      terminalCompletedAt: 3,
      terminalExitCode: 7,
    }));

    expect(projectAgentSession(session, 1).terminals).toEqual([expect.objectContaining({
      id: 'terminal-short',
      revealed: false,
      state: 'exited',
      outcome: 'command-failed',
      exitCode: 7,
    })]);
  });

  it('projects cancellation as exited even if an older terminal state said running', () => {
    const session = createEmptyAgentSession({
      id: 'session-2',
      anchor: { kind: 'workspace', path: '.iris' },
      model: { provider: 'openai', modelId: 'gpt-test' },
      projectRoot: process.cwd(),
      displayName: 'Iris Agent',
      injection,
      now: 1,
    });
    session.timeline.push(terminalActivity({
      state: 'canceled',
      terminalId: 'terminal-canceled',

      terminalState: 'running',
      terminalStartedAt: 2,
      terminalRevealedAt: 3,
      completedAt: 4,
    }));

    expect(projectAgentSession(session, 1).terminals).toEqual([expect.objectContaining({
      id: 'terminal-canceled',
      revealed: true,
      state: 'exited',
      outcome: 'canceled',
      completedAt: 4,
    })]);
  });

  it('projects a settled terminal without requiring a persisted output artifact', () => {
    const session = createEmptyAgentSession({
      id: 'session-legacy',
      anchor: { kind: 'workspace', path: '.iris' },
      model: { provider: 'openai', modelId: 'gpt-test' },
      projectRoot: process.cwd(),
      displayName: 'Iris Agent',
      injection,
      now: 1,
    });
    session.timeline.push(terminalActivity({
      state: 'completed',
      terminalId: 'terminal-legacy',
      resultSummary: 'PowerShell: exit 0, 10 bytes',
      completedAt: 3,
    }));
    expect(projectAgentSession(session, 1).terminals).toEqual([expect.objectContaining({
      id: 'terminal-legacy',
      revealed: false,
      state: 'exited',
      startedAt: 1,
      completedAt: 3,
    })]);
    expect(projectAgentSession(session, 1).terminals[0]).not.toHaveProperty('outcome');
  });

  it('projects context usage and drops a snapshot that cannot describe a window', () => {
    const session = createEmptyAgentSession({
      id: 'session-usage',
      anchor: { kind: 'workspace', path: '.iris' },
      model: { provider: 'openai', modelId: 'gpt-test' },
      projectRoot: process.cwd(),
      displayName: 'Iris Agent',
      injection,
      now: 1,
    });
    expect(projectAgentSession(session, 1).contextUsage).toBeUndefined();
    session.contextBudget = { windowTokens: 128_000, triggerTokens: 112_000 };
    session.contextUsage = { usedTokens: 12_000, measurement: 'reported', updatedAt: 2 };
    expect(projectAgentSession(session, 1).contextBudget).toEqual({
      windowTokens: 128_000, triggerTokens: 112_000,
    });
    expect(projectAgentSession(session, 1).contextUsage).toEqual({
      usedTokens: 12_000, measurement: 'reported', updatedAt: 2,
    });

    const legacy = createEmptyAgentSession({
      id: 'session-usage-legacy',
      anchor: { kind: 'workspace', path: '.iris' },
      model: { provider: 'openai', modelId: 'gpt-test' },
      projectRoot: process.cwd(),
      displayName: 'Iris Agent',
      injection,
      now: 1,
    });
    legacy.contextBudget = { windowTokens: 0, triggerTokens: 0 };
    legacy.contextUsage = { usedTokens: 120, measurement: 'reported', updatedAt: 1 };
    legacy.contextPromptTokens = -1;
    normalizeAgentSessionAggregate(legacy);
    expect(legacy.contextBudget).toBeUndefined();
    // A reading without its window has no denominator left, so it goes too.
    expect(legacy.contextUsage).toBeUndefined();
    // The reused method-layer size is a count or nothing.
    expect(legacy.contextPromptTokens).toBeUndefined();
    legacy.contextBudget = { windowTokens: 128_000, triggerTokens: 112_000 };
    legacy.contextPromptTokens = 2_523;
    normalizeAgentSessionAggregate(legacy);
    expect(legacy.contextPromptTokens).toBe(2_523);
  });

  it('projects each background task as its own card without folding it into retrievals', () => {
    const session = createEmptyAgentSession({
      id: 'session-task-card',
      anchor: { kind: 'workspace', path: '.iris' },
      model: { provider: 'openai', modelId: 'gpt-test' },
      projectRoot: process.cwd(),
      displayName: 'Iris Agent',
      injection,
      now: 1,
    });
    session.intents.push({
      id: 'intent-task-card', content: 'run a server', turnIds: [], state: 'completed',
      assembledInputAvailable: true, createdAt: 1,
    });
    session.activeIntentIds.push('intent-task-card');
    session.tasks.push({
      taskId: 'task-1', sessionId: session.id, intentId: 'intent-task-card', title: 'Dev server',
      command: 'npm run dev', cwd: '.', status: 'running', createdAt: 2, outputBytes: 12,
      logRef: 'tasks/task-1.log',
    });
    session.timeline.push(terminalActivity({
      id: 'task-start-tool', toolCallId: 'task-start-tool', tool: 'task_start',
      operation: 'start', inputSummary: 'start Dev server: npm run dev', state: 'completed',
    }));

    const cards = projectAgentSession(session, 1).intents[0]!.cards;
    expect(cards).toContainEqual(expect.objectContaining({ kind: 'task', taskId: 'task-1', state: 'running' }));
    expect(cards.some((card) => card.kind === 'local-retrieval' && card.items.some((item) => item.id === 'task-start-tool')))
      .toBe(false);
    // The dialog header shows the working directory, so the projection must
    // carry it instead of stripping it like the internal fields.
    expect(projectAgentSession(session, 1).tasks).toContainEqual(
      expect.objectContaining({ taskId: 'task-1', cwd: '.' }),
    );
  });
});
