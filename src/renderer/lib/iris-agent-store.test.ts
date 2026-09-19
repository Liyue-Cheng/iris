import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IrisAgentView } from '@renderer/components/agent/IrisAgentView';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import {
  irisAgentAnchorKey,
  irisAgentStore,
  hydrateIrisAgentSessions,
} from '@renderer/stores/iris-agent-store';
import { sessionViewStore } from '@renderer/stores/session-view-store';
import { irisAgentSessionKey } from '@renderer/lib/session-projection';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import type { IrisAgentListSnapshot, IrisAgentSessionInfo, ProjectScope } from '@shared/types';

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

  it('keeps the pause banner when an older list arrives after the pause event', async () => {
    const failed = session('a', '.iris/issue/a.md');
    failed.revision = 1169;
    failed.state = 'running';
    failed.currentIntentId = 'intent-1';
    failed.intents = [{
      id: 'intent-1', state: 'running', canFork: false,
      user: { id: 'user-1', content: 'implement', createdAt: 1, contextAvailable: true },
      cards: [{
        kind: 'agent-reply', id: 'reply-1', state: 'failed', content: '',
        excludedFromContext: true, error: 'bad_response: stream ended with reason timeout',
      }],
    }];
    irisAgentStore.handleChanged(failed);
    let resolveList!: (snapshot: IrisAgentListSnapshot) => void;
    const response = new Promise<IrisAgentListSnapshot>((resolve) => { resolveList = resolve; });
    const invoke = vi.spyOn(window.api, 'invoke').mockReturnValue(response);
    try {
      const loading = hydrateIrisAgentSessions();
      const { revision: _revision, intents: _intents, ...header } = failed;
      expect(irisAgentStore.handleProjectionUpdate({
        kind: 'patch', sessionId: failed.id, baseRevision: 1169, revision: 1170,
        session: {
          ...header, state: 'paused',
          pause: { reason: 'provider', message: 'bad_response: stream ended with reason timeout' },
        },
        intents: [{
          operation: 'upsert', index: 0,
          intent: { id: 'intent-1', state: 'paused', canFork: true, user: failed.intents[0]!.user },
          cards: [],
        }],
      })).toBe('applied');
      resolveList({ scope, sessions: [failed] });
      expect(await loading).toBe(true);
      const actual = irisAgentStore.get().sessions[0]!;
      expect(actual).toMatchObject({ revision: 1170, state: 'paused', pause: { reason: 'provider' } });
      const html = renderView(actual);
      expect(html).toContain('bad_response');
      expect(html).toContain('请求已暂停');
      expect((html.match(/继续/gu) ?? [])).toHaveLength(1);
    } finally {
      invoke.mockRestore();
    }
  });

  it('keeps sessions opened during hydration and does not resurrect closed sessions', async () => {
    const closed = session('a', '.iris/issue/a.md');
    irisAgentStore.handleChanged(closed);
    let resolveList!: (snapshot: IrisAgentListSnapshot) => void;
    const response = new Promise<IrisAgentListSnapshot>((resolve) => { resolveList = resolve; });
    const invoke = vi.spyOn(window.api, 'invoke').mockReturnValue(response);
    try {
      const loading = hydrateIrisAgentSessions();
      irisAgentStore.handleDestroyed(closed.id);
      const opened = session('b', '.iris/issue/b.md');
      irisAgentStore.handleChanged(opened);
      resolveList({ scope, sessions: [closed] });
      await loading;
      expect(irisAgentStore.get().sessions).toEqual([opened]);
    } finally {
      invoke.mockRestore();
    }
  });

  it('ignores an older overlapping hydration response', async () => {
    const old = session('a', '.iris/issue/a.md');
    irisAgentStore.handleChanged(old);
    let resolveFirst!: (snapshot: IrisAgentListSnapshot) => void;
    let resolveSecond!: (snapshot: IrisAgentListSnapshot) => void;
    const first = new Promise<IrisAgentListSnapshot>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<IrisAgentListSnapshot>((resolve) => { resolveSecond = resolve; });
    const invoke = vi.spyOn(window.api, 'invoke').mockReturnValueOnce(first).mockReturnValueOnce(second);
    try {
      const loadingFirst = hydrateIrisAgentSessions();
      const loadingSecond = hydrateIrisAgentSessions();
      resolveSecond({ scope, sessions: [] });
      await loadingSecond;
      resolveFirst({ scope, sessions: [old] });
      await loadingFirst;
      expect(irisAgentStore.get().sessions).toEqual([]);
    } finally {
      invoke.mockRestore();
    }
  });

  it('renders every operation of a group, with its tool counters and file results', () => {
    const view = session('a', '.iris/issue/a.md');
    view.intents = [{
      id: 'intent-1',
      state: 'completed',
      user: { id: 'user-1', content: 'inspect', createdAt: 1, contextAvailable: true },
      canFork: false,
      cards: [
        {
          kind: 'local-retrieval', id: 'r1', state: 'completed',
          items: [
            { id: 'i1', kind: 'file', label: 'src/first.ts', state: 'completed' },
            { id: 'i2', kind: 'file', label: 'src/second.ts', state: 'completed' },
            { id: 'i3', kind: 'file', label: 'src/third.ts', state: 'completed' },
            { id: 'i4', kind: 'query', label: 'git status', state: 'completed' },
          ],
        },
        {
          kind: 'file-change', id: 'f1', state: 'completed', path: 'src/a.ts',
          tool: 'edit', action: 'created', diff: '--- a\n+++ b\n@@ -0,0 +1,2 @@\n+one\n+two\n',
        },
        {
          kind: 'file-change', id: 'f2', state: 'failed', path: 'src/b.ts',
          tool: 'write', action: 'attempted',
        },
      ],
    }];

    const html = renderView(view);
    // Six rows: the counters only appear because more than five do not fit.
    expect(html).toContain('3读取 · 1信息 · 2编辑 · 1错误');
    expect(html).toContain('创建');
    expect(html).toContain('+2');
    expect(html).toContain('写入失败');
    // The last operation is rendered as well: the window scrolls rather than dropping it.
    expect(html).toContain('src/b.ts');
  });
});
