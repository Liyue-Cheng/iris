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
  branchIrisAgent: vi.fn(),
  listIrisAgentModels: vi.fn(async () => ({ models: [] })),
  retryIrisAgent: vi.fn(),
  rewindIrisAgent: vi.fn(),
  openIrisAgentContext: vi.fn(),
  sendIrisAgentMessage: vi.fn(),
  setIrisAgentModel: vi.fn(),
  stopIrisAgent: vi.fn(),
}));

const scope: ProjectScope = { root: 'C:/project', generation: 1 };

function session(id: string, path: string): IrisAgentSessionInfo {
  return {
    id,
    kind: 'iris-agent',
    anchor: { kind: 'document', path },
    model: { provider: 'openai', modelId: 'gpt-test' },
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

  it('projects tool activity into grouped evidence cards before the final answer', () => {
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
    completed.toolEvents = [
      {
        id: 'tool-1',
        turnId: 'turn-1',
        requestId: 'request-1',
        name: 'read',
        operation: 'readFile',
        state: 'completed',
        createdAt: 2,
        inputSummary: 'read issue',
        path: '.iris/issue/task.md',
        resultSummary: '120 bytes',
      },
      {
        id: 'tool-2',
        turnId: 'turn-1',
        requestId: 'request-1',
        name: 'terminal',
        operation: 'exec',
        terminalIntent: 'information',
        command: 'git status --short',
        cwd: '.',
        state: 'completed',
        createdAt: 3,
        inputSummary: 'git status --short',
        resultSummary: 'exit 0',
      },
      {
        id: 'tool-3',
        turnId: 'turn-1',
        requestId: 'request-1',
        name: 'edit',
        operation: 'writeFile',
        state: 'completed',
        createdAt: 4,
        inputSummary: 'writeFile src/value.ts',
        path: 'src/value.ts',
        resultSummary: 'updated',
        diff: '--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-old\n+new',
      },
      {
        id: 'tool-4',
        turnId: 'turn-1',
        requestId: 'request-1',
        name: 'terminal',
        operation: 'exec',
        terminalIntent: 'operation',
        command: 'npm test -- --run src/value.test.ts',
        cwd: '.',
        state: 'completed',
        createdAt: 5,
        inputSummary: 'npm test -- --run src/value.test.ts',
        resultSummary: 'exit 0',
      },
      {
        id: 'tool-5',
        turnId: 'turn-1',
        requestId: 'request-1',
        name: 'read',
        operation: 'readFile',
        state: 'completed',
        createdAt: 6,
        inputSummary: 'read src/value.test.ts',
        path: 'src/value.test.ts',
        resultSummary: '80 bytes',
      },
    ];

    const html = renderToStaticMarkup(createElement(IrisAgentView, { session: completed }));
    expect(html.indexOf('check tools')).toBeLessThan(html.indexOf('本地获取'));
    expect(html.indexOf('本地获取')).toBeLessThan(html.indexOf('文件写入'));
    expect(html.indexOf('文件写入')).toBeLessThan(html.indexOf('操作终端'));
    expect(html.indexOf('操作终端')).toBeLessThan(html.indexOf('最终输出'));
    expect(html.indexOf('最终输出')).toBeLessThan(html.indexOf('all tools checked'));
    expect(html.match(/aria-label="本地获取"/g)).toHaveLength(2);
    expect(html.match(/aria-label="文件写入"/g)).toHaveLength(1);
    expect(html.match(/aria-label="操作终端"/g)).toHaveLength(1);
    expect(html.match(/aria-label="最终输出"/g)).toHaveLength(1);
    expect(html).toContain('git status --short');
    expect(html).toContain('npm test -- --run src/value.test.ts');
    expect(html).toContain('-old');
    expect(html).toContain('+new');
    expect(html.match(/aria-label="打开组装输入（旧版）"/g)).toHaveLength(1);
    expect(html).toContain('撤销上一轮');
    expect(html).not.toContain('重试');

    completed.turns[0]!.status = 'stopped';
    const stoppedHtml = renderToStaticMarkup(createElement(IrisAgentView, { session: completed }));
    expect(stoppedHtml).toContain('重试');
    expect(stoppedHtml).toContain('撤销上一轮');

    completed.state = 'failed';
    completed.turns[0]!.status = 'failed';
    completed.turns[0]!.error = 'Provider request failed';
    const failedHtml = renderToStaticMarkup(createElement(IrisAgentView, { session: completed }));
    expect(failedHtml).not.toContain('aria-label="Iris Agent 运行错误"');
    expect(failedHtml).toContain('aria-label="最终输出"');
    expect(failedHtml).toContain('Provider request failed');
    expect(failedHtml.match(/>重试</g)).toHaveLength(1);

    completed.turns.push({
      id: 'turn-2',
      userMessageId: 'u2',
      requestId: 'request-2',
      status: 'completed',
      createdAt: 3,
      completedAt: 4,
    });
    const historicalFailureHtml = renderToStaticMarkup(createElement(IrisAgentView, { session: completed }));
    expect(historicalFailureHtml).toContain('Provider request failed');
    expect(historicalFailureHtml).not.toContain('>重试<');

    completed.turns.pop();
    delete completed.turns[0]!.error;
    completed.state = 'running';
    completed.activeTurnId = 'turn-1';
    completed.turns[0]!.status = 'running';
    const streamingHtml = renderToStaticMarkup(createElement(IrisAgentView, { session: completed }));
    expect(streamingHtml.match(/aria-label="打开组装输入（旧版）"/g)).toHaveLength(1);
  });
});
