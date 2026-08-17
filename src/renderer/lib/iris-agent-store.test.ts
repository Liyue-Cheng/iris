import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IrisAgentView } from '@renderer/components/agent/IrisAgentView';
import {
  irisAgentAnchorKey,
  irisAgentStore,
  selectedIrisAgentIdForAnchor,
} from '@renderer/stores/iris-agent-store';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import type { IrisAgentSessionInfo, ProjectScope } from '@shared/types';

vi.mock('@renderer/lib/iris-agent-actions', () => ({
  retryIrisAgent: vi.fn(),
  rewindIrisAgent: vi.fn(),
  openIrisAgentContext: vi.fn(),
  sendIrisAgentMessage: vi.fn(),
  stopIrisAgent: vi.fn(),
}));

const scope: ProjectScope = { root: 'C:/project', generation: 1 };

function session(id: string, path: string): IrisAgentSessionInfo {
  return {
    id,
    kind: 'iris-agent',
    anchor: { kind: 'document', path },
    projectRoot: scope.root,
    projectGeneration: scope.generation,
    displayName: 'Iris Agent',
    state: 'idle',
    createdAt: id === 'a' ? 1 : 2,
    updatedAt: id === 'a' ? 1 : 2,
    revision: id === 'a' ? 1 : 2,
    workerEpoch: 0,
    activeTurnId: null,
    messages: [],
    turns: [],
    toolEvents: [],
    fileEffects: [],
    requestFacts: [],
    selfHostingEligible: false,
  };
}

describe('irisAgentStore', () => {
  beforeEach(() => {
    projectScopeState.set(scope);
    irisAgentStore.reset([], scope);
  });

  it('groups by anchor and keeps sticky selection valid', () => {
    const first = session('a', '.iris/issue/a.md');
    const second = session('b', '.iris/issue/a.md');
    irisAgentStore.handleChanged(first);
    irisAgentStore.handleChanged(second);

    const key = irisAgentAnchorKey(first.anchor);
    expect(selectedIrisAgentIdForAnchor(key)).toBe('a');
    expect(irisAgentStore.select('b')).toBe(true);
    expect(selectedIrisAgentIdForAnchor(key)).toBe('b');

    irisAgentStore.handleDestroyed('b');
    expect(selectedIrisAgentIdForAnchor(key)).toBe('a');
  });

  it('does not let an older IPC response replace a newer session event', () => {
    const newer = { ...session('a', '.iris/issue/a.md'), state: 'running' as const, revision: 10 };
    const older = { ...newer, state: 'idle' as const, revision: 9, updatedAt: 99 };

    irisAgentStore.handleChanged(newer);
    irisAgentStore.handleChanged(older);

    expect(irisAgentStore.get().sessions).toHaveLength(1);
    expect(irisAgentStore.get().sessions[0]).toMatchObject({ state: 'running', revision: 10 });
  });

  it('renders compact tool events before the final assistant answer', () => {
    const completed = session('a', '.iris/issue/a.md');
    completed.messages = [
      { id: 'u1', turnId: 'turn-1', role: 'user', content: 'check tools', createdAt: 1 },
      { id: 'a1', turnId: 'turn-1', role: 'assistant', content: 'all tools checked', createdAt: 2 },
    ];
    completed.turns = [{
      id: 'turn-1',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      requestId: 'request-1',
      promptAvailable: true,
      status: 'completed',
      createdAt: 1,
      completedAt: 2,
    }];
    completed.toolEvents = [{
      id: 'tool-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      name: 'read',
      state: 'completed',
      createdAt: 2,
      inputSummary: 'read issue',
      resultSummary: 'tool result',
    }];

    const html = renderToStaticMarkup(createElement(IrisAgentView, { session: completed }));
    expect(html.indexOf('check tools')).toBeLessThan(html.indexOf('tool result'));
    expect(html.indexOf('tool result')).toBeLessThan(html.indexOf('all tools checked'));
    expect(html.match(/aria-label="打开组装输入（旧版）"/g)).toHaveLength(2);
    expect(html).toContain('撤销上一轮');
    expect(html).not.toContain('重试');

    completed.turns[0]!.status = 'stopped';
    const stoppedHtml = renderToStaticMarkup(createElement(IrisAgentView, { session: completed }));
    expect(stoppedHtml).toContain('重试');
    expect(stoppedHtml).toContain('撤销上一轮');

    completed.state = 'running';
    completed.activeTurnId = 'turn-1';
    completed.turns[0]!.status = 'running';
    const streamingHtml = renderToStaticMarkup(createElement(IrisAgentView, { session: completed }));
    expect(streamingHtml.match(/aria-label="打开组装输入（旧版）"/g)).toHaveLength(2);
  });
});
