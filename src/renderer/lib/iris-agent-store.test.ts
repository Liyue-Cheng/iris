import { beforeEach, describe, expect, it } from 'vitest';
import {
  irisAgentAnchorKey,
  irisAgentStore,
  selectedIrisAgentIdForAnchor,
} from '@renderer/stores/iris-agent-store';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import type { IrisAgentSessionInfo, ProjectScope } from '@shared/types';

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
});
