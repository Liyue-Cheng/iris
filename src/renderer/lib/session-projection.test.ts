import { describe, expect, it } from 'vitest';
import type { IrisAgentSessionInfo, TerminalSessionInfo } from '@shared/types';
import {
  aggregateProjectionState,
  irisAgentSessionProjection,
  projectSessions,
  sessionProjectionAnchorKey,
  terminalSessionProjection,
} from './session-projection';

const terminal = (overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo => ({
  id: 't1', docPath: 'issue/a.md', workspacePath: null, agentId: 'shell',
  displayName: 'Shell', terminalTitle: null, projectRoot: 'C:/p', projectGeneration: 1,
  cols: 80, rows: 24, pid: 1, state: 'idle', createdAt: 1, ...overrides,
});

const agent = (overrides: Partial<IrisAgentSessionInfo> = {}): IrisAgentSessionInfo => ({
  id: 'a1', kind: 'iris-agent', anchor: { kind: 'document', path: 'issue/a.md' },
  model: null, projectRoot: 'C:/p', projectGeneration: 1, displayName: 'Iris Agent',
  state: 'ready', createdAt: 2, updatedAt: 3, revision: 1, currentIntentId: null,
  intents: [], terminals: [], canRewindLatestIntent: false, selfHostingEligible: false, ...overrides,
});

describe('session projection', () => {
  it('uses typed keys and preserves anchor namespaces', () => {
    const terminalView = terminalSessionProjection(terminal());
    const agentView = irisAgentSessionProjection(agent());
    expect(terminalView.key).toBe('terminal:t1');
    expect(agentView.key).toBe('iris-agent:a1');
    expect(sessionProjectionAnchorKey(agentView.anchor)).toBe('issue/a.md');
  });

  it('merges domain sessions in creation order and gives active priority', () => {
    const views = projectSessions([terminal({ state: 'active' })], [agent()]);
    expect(views.map((view) => view.key)).toEqual(['terminal:t1', 'iris-agent:a1']);
    expect(aggregateProjectionState(views, 'issue/a.md')).toBe('active');
  });
});
