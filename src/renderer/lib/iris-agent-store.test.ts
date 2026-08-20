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
  resumeIrisAgent: vi.fn(),
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
    currentTurnId: null,
    turns: [],
    terminals: [],
    canUndoLatestTurn: false,
    selfHostingEligible: false,
  };
}

describe('irisAgentStore v2 projection', () => {
  beforeEach(() => {
    projectScopeState.set(scope);
    irisAgentStore.reset([], scope);
  });

  it('keeps sticky anchor selection and rejects an older snapshot', () => {
    const first = session('a', '.iris/issue/a.md');
    const second = session('b', '.iris/issue/a.md');
    irisAgentStore.handleChanged(first);
    irisAgentStore.handleChanged(second);
    const key = irisAgentAnchorKey(first.anchor);
    expect(selectedIrisAgentIdForAnchor(key)).toBe('a');
    irisAgentStore.select('b');
    expect(selectedIrisAgentIdForAnchor(key)).toBe('b');

    const newer = { ...second, state: 'running' as const, revision: 10 };
    irisAgentStore.handleChanged(newer);
    irisAgentStore.handleChanged({ ...newer, state: 'idle', revision: 9 });
    expect(irisAgentStore.get().sessions.find((candidate) => candidate.id === 'b')).toMatchObject({
      state: 'running', revision: 10,
    });
  });

  it('renders the main-projected card order and stable identities without merging raw events', () => {
    const projected = session('a', '.iris/issue/a.md');
    projected.turns = [{
      id: 'turn-1',
      state: 'fulfilled',
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
    projected.canUndoLatestTurn = true;
    const html = renderToStaticMarkup(createElement(IrisAgentView, { session: projected }));
    expect(html.indexOf('src/a.ts')).toBeLessThan(html.indexOf('partial A'));
    expect(html.indexOf('partial A')).toBeLessThan(html.indexOf('answer B'));
    expect(html).toContain('未进入上下文');
  });

  it('shows exactly one Continue control from the session pause projection', () => {
    const paused = session('a', '.iris/issue/a.md');
    paused.state = 'paused';
    paused.currentTurnId = 'turn-1';
    paused.pause = { reason: 'provider', message: 'rate limited' };
    const html = renderToStaticMarkup(createElement(IrisAgentView, { session: paused }));
    expect((html.match(/继续/gu) ?? [])).toHaveLength(1);
    expect(html).toContain('rate limited');
  });

  it('applies contiguous card patches by ID and rejects a revision gap', () => {
    const initial = session('a', '.iris/issue/a.md');
    initial.revision = 1;
    initial.turns = [{
      id: 'turn-1',
      state: 'active',
      user: { id: 'user-1', content: 'inspect', createdAt: 1, contextAvailable: true },
      cards: [{
        kind: 'agent-reply', id: 'reply-1', state: 'running', content: 'A', excludedFromContext: false,
      }],
      canFork: false,
    }];
    irisAgentStore.handleChanged(initial);
    const { revision: _revision, turns: _turns, ...header } = initial;
    expect(irisAgentStore.handleProjectionUpdate({
      kind: 'patch',
      sessionId: initial.id,
      baseRevision: 1,
      revision: 2,
      session: { ...header, state: 'running', updatedAt: 2 },
      turns: [{
        operation: 'upsert',
        index: 0,
        turn: { id: 'turn-1', state: 'active', user: initial.turns[0]!.user, canFork: false },
        cards: [{
          operation: 'upsert',
          index: 0,
          card: {
            kind: 'agent-reply', id: 'reply-1', state: 'running', content: 'AB', excludedFromContext: false,
          },
        }],
      }],
    })).toBe('applied');
    expect(irisAgentStore.get().sessions[0]?.turns[0]?.cards[0]).toMatchObject({ content: 'AB' });

    expect(irisAgentStore.handleProjectionUpdate({
      kind: 'patch',
      sessionId: initial.id,
      baseRevision: 3,
      revision: 4,
      session: header,
      turns: [],
    })).toBe('gap');
    expect(irisAgentStore.get().sessions[0]?.revision).toBe(2);
  });
});
