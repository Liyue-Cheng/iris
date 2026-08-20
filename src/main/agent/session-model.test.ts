import { describe, expect, it } from 'vitest';
import { createEmptyAgentSession, projectAgentSession, type AgentToolActivity } from './session-model';

function terminalActivity(overrides: Partial<AgentToolActivity>): AgentToolActivity {
  return {
    kind: 'tool',
    id: 'tool-terminal',
    ordinal: 1,
    turnId: 'turn-1',
    providerCallId: 'provider-1',
    toolCallId: 'tool-terminal',
    tool: 'terminal',
    intent: 'operation',
    state: 'running',
    inputSummary: 'terminal command',
    operation: 'exec',
    command: 'terminal command',
    cwd: '.',
    effectIds: [],
    createdAt: 1,
    ...overrides,
  };
}

describe('Iris Agent terminal projection', () => {
  it('keeps short completed terminals available without marking them revealed', () => {
    const session = createEmptyAgentSession({
      id: 'session-1',
      anchor: { kind: 'workspace', path: '.iris' },
      model: { provider: 'openai', modelId: 'gpt-test' },
      projectRoot: process.cwd(),
      displayName: 'Iris Agent',
      now: 1,
    });
    session.timeline.push(terminalActivity({
      state: 'failed',
      terminalId: 'terminal-short',
      terminalArtifactRef: 'terminal/terminal-short.log',
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
      now: 1,
    });
    session.timeline.push(terminalActivity({
      state: 'canceled',
      terminalId: 'terminal-canceled',
      terminalArtifactRef: 'terminal/terminal-canceled.log',
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

  it('derives legacy terminal replay availability without inventing an outcome', () => {
    const session = createEmptyAgentSession({
      id: 'session-legacy',
      anchor: { kind: 'workspace', path: '.iris' },
      model: { provider: 'openai', modelId: 'gpt-test' },
      projectRoot: process.cwd(),
      displayName: 'Iris Agent',
      now: 1,
    });
    session.timeline.push(terminalActivity({
      state: 'completed',
      terminalId: 'terminal-legacy',
      resultSummary: 'PowerShell: exit 0, 10 bytes',
      completedAt: 3,
    }));
    session.effects.push({
      id: 'terminal--legacy',
      turnId: 'turn-1',
      toolActivityId: 'tool-terminal',
      kind: 'terminal-output',
      artifactRef: 'terminal/terminal-legacy.log',
      createdAt: 3,
    });

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
