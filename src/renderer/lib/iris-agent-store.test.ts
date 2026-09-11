import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IrisAgentView } from '@renderer/components/agent/IrisAgentView';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import {
  irisAgentAnchorKey,
  irisAgentStore,
} from '@renderer/stores/iris-agent-store';
import { sessionViewStore } from '@renderer/stores/session-view-store';
import { irisAgentSessionKey } from '@renderer/lib/session-projection';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import type { IrisAgentSessionInfo, ProjectScope } from '@shared/types';

/**
 * The view assumes the app-level tooltip provider, exactly as `App.tsx` mounts
 * it, so a static render has to supply it too.
 */
function renderView(session: IrisAgentSessionInfo): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      { delayDuration: 400, children: createElement(IrisAgentView, { session }) },
    ),
  );
}

// The view tree reaches the shell-action boundary, whose CPU pipeline publishes
// a dev console handle on `window` while its module loads. A static render never
// touches it, but the global has to exist before the import graph is evaluated.
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = {
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    api: {
      windowsBuild: null,
      invoke: async () => ({}),
      on: () => () => undefined,
    },
  };
});

vi.mock('@renderer/lib/iris-agent-actions', () => ({
  branchIrisAgent: vi.fn(),
  listIrisAgentModels: vi.fn(async () => ({ models: [] })),
  resumeIrisAgent: vi.fn(),
  rewindIrisAgent: vi.fn(),
  openIrisAgentContext: vi.fn(),
  sendIrisAgentMessage: vi.fn(),
  setIrisAgentModel: vi.fn(),
  stopIrisAgent: vi.fn(),
  cancelIrisAgentTask: vi.fn(),
  continueIrisAgentTerminalSupervision: vi.fn(),
  readIrisAgentTaskLog: vi.fn(),
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
    currentIntentId: null,
    intents: [],
    terminals: [],
    canRewindLatestIntent: false,
    selfHostingEligible: false,
  };
}

describe('irisAgentStore Intent projection', () => {
  beforeEach(() => {
    projectScopeState.set(scope);
    irisAgentStore.reset([], scope);
    sessionViewStore.clear();
  });

  it('keeps sticky anchor selection and rejects an older snapshot', () => {
    const first = session('a', '.iris/issue/a.md');
    const second = session('b', '.iris/issue/a.md');
    irisAgentStore.handleChanged(first);
    irisAgentStore.handleChanged(second);
    const key = irisAgentAnchorKey(first.anchor);
    expect(sessionViewStore.selected(scope, key)).toBeNull();
    sessionViewStore.select(scope, key, irisAgentSessionKey('b'));
    expect(sessionViewStore.selected(scope, key)).toBe('iris-agent:b');

    const newer = { ...second, state: 'running' as const, revision: 10 };
    irisAgentStore.handleChanged(newer);
    irisAgentStore.handleChanged({ ...newer, state: 'idle', revision: 9 });
    expect(irisAgentStore.get().sessions.find((candidate) => candidate.id === 'b')).toMatchObject({
      state: 'running', revision: 10,
    });
  });

  it('renders the main-projected card order and stable identities without merging raw events', () => {
    const projected = session('a', '.iris/issue/a.md');
    projected.intents = [{
      id: 'intent-1',
      state: 'completed',
      user: {
        id: 'user-1', content: 'inspect', createdAt: 1,
        contextAvailable: true, contextTitle: 'Open provider context (1 calls)',
      },
      cards: [
        {
          kind: 'local-retrieval', id: 'tool-1', state: 'completed',
          items: [{ id: 'tool-1', kind: 'file', label: 'src/a.ts', state: 'completed' }],
        },
        {
          kind: 'agent-reply', id: 'reply-a', state: 'stopped', content: 'partial A',
          excludedFromContext: true,
        },
        {
          kind: 'agent-reply', id: 'reply-b', state: 'completed', content: 'answer B',
          excludedFromContext: false,
        },
      ],
      canFork: true,
    }];
    projected.canRewindLatestIntent = true;
    const html = renderView(projected);
    expect(html.indexOf('src/a.ts')).toBeLessThan(html.indexOf('partial A'));
    expect(html.indexOf('partial A')).toBeLessThan(html.indexOf('answer B'));
    expect(html).toContain('未进入上下文');
  });

  it('renders a task card and header entry without inlining the log', () => {
    const projected = session('a', '.iris/issue/a.md');
    projected.state = 'running';
    projected.tasks = [{
      taskId: 'task-1',
      sessionId: 'a',
      intentId: 'intent-1',
      title: 'Dev server',
      command: 'npm run dev',
      cwd: '.',
      status: 'running',
      createdAt: 1,
      outputBytes: 2048,
      logRef: 'C:/userData/iris-agent-tasks/logs/task-1.log',
    }];
    projected.intents = [{
      id: 'intent-1',
      state: 'running',
      user: { id: 'user-1', content: 'run the server', createdAt: 1, contextAvailable: false },
      cards: [{
        kind: 'task',
        id: 'task-card:task-1',
        taskId: 'task-1',
        title: 'Dev server',
        command: 'npm run dev',
        state: 'running',
        status: 'running',
        outputBytes: 2048,
        logRef: 'C:/userData/iris-agent-tasks/logs/task-1.log',
      }],
      canFork: false,
    }];

    const html = renderView(projected);

    // The card is an entry point, not a log viewer: the dialog owns the bytes.
    expect(html).toContain('打开任务');
    expect(html).not.toContain('查看日志');
    expect(html).toContain('运行中');
    // The header icon appears with a live task count and opens the dialog.
    expect(html).toContain('查看后台任务（1 个仍在运行）');
  });

  it('shows exactly one Continue control from the session pause projection', () => {
    const paused = session('a', '.iris/issue/a.md');
    paused.state = 'paused';
    paused.currentIntentId = 'intent-1';
    paused.pause = { reason: 'provider', message: 'rate limited' };
    const html = renderView(paused);
    expect((html.match(/继续/gu) ?? [])).toHaveLength(1);
    expect(html).toContain('rate limited');
  });

  it('applies contiguous card patches by ID and rejects a revision gap', () => {
    const initial = session('a', '.iris/issue/a.md');
    initial.revision = 1;
    initial.intents = [{
      id: 'intent-1',
      state: 'running',
      user: { id: 'user-1', content: 'inspect', createdAt: 1, contextAvailable: true },
      cards: [{
        kind: 'agent-reply', id: 'reply-1', state: 'running', content: 'A', excludedFromContext: false,
      }],
      canFork: false,
    }];
    irisAgentStore.handleChanged(initial);
    const { revision: _revision, intents: _intents, ...header } = initial;
    expect(irisAgentStore.handleProjectionUpdate({
      kind: 'patch',
      sessionId: initial.id,
      baseRevision: 1,
      revision: 2,
      session: { ...header, state: 'running', updatedAt: 2 },
      intents: [{
        operation: 'upsert',
        index: 0,
        intent: { id: 'intent-1', state: 'running', user: initial.intents[0]!.user, canFork: false },
        cards: [{
          operation: 'upsert',
          index: 0,
          card: {
            kind: 'agent-reply', id: 'reply-1', state: 'running', content: 'AB', excludedFromContext: false,
          },
        }],
      }],
    })).toBe('applied');
    expect(irisAgentStore.get().sessions[0]?.intents[0]?.cards[0]).toMatchObject({ content: 'AB' });

    expect(irisAgentStore.handleProjectionUpdate({
      kind: 'patch',
      sessionId: initial.id,
      baseRevision: 3,
      revision: 4,
      session: header,
      intents: [],
    })).toBe('gap');
    expect(irisAgentStore.get().sessions[0]?.revision).toBe(2);
  });
});
