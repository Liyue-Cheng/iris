import { describe, expect, it } from 'vitest';
import { createEmptyAgentSession, projectAgentSession, type AgentToolActivity } from './session-model';
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
});
