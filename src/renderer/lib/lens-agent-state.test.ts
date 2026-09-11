import { describe, expect, it } from 'vitest';
import type { IrisAgentSessionInfo, TerminalSessionInfo } from '@shared/types';
import { agentActivityState, aggregateCombinedDocState } from '@renderer/lib/agent-session-state';

function agent(state: IrisAgentSessionInfo['state'], path = '.iris/issue/task.md'): IrisAgentSessionInfo {
  return {
    id: `agent-${state}`,
    kind: 'iris-agent',
    anchor: { kind: 'document', path },
    model: null,
    projectRoot: 'C:/project',
    projectGeneration: 1,
    displayName: 'Iris Agent',
    state,
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    workerEpoch: 0,
    currentIntentId: null,
    intents: [],
    terminals: [],
    canRewindLatestIntent: false,
    selfHostingEligible: false,
  };
}

describe('LensTree Iris Agent state projection', () => {
  it('maps busy states to active and quiescent states to idle', () => {
    expect(agentActivityState('waiting-tool')).toBe('active');
    expect(agentActivityState('stopping')).toBe('active');
    expect(agentActivityState('paused')).toBe('idle');
    expect(agentActivityState('ready')).toBe('idle');
  });

  it('shows an Agent-only document dot and lets active win over terminal idle', () => {
    expect(aggregateCombinedDocState([], [agent('idle')], '.iris/issue/task.md')).toBe('idle');
    const terminal = {
      docPath: '.iris/issue/task.md',
      workspacePath: null,
      state: 'idle',
    } as TerminalSessionInfo;
    expect(aggregateCombinedDocState([terminal], [agent('running')], '.iris/issue/task.md')).toBe('active');
  });
});
