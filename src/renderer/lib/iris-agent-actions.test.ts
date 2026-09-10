import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IrisAgentSessionInfo,
  IrisScanResult,
  ProjectScope,
} from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import { sessionViewStore } from '@renderer/stores/session-view-store';
import {
  irisAgentStore,
} from '@renderer/stores/iris-agent-store';
import { irisAgentSessionKey } from '@renderer/lib/session-projection';
import { workspaceAnchorKey } from '@renderer/stores/session-store';

let projectStore: typeof import('@renderer/stores/project-store').projectStore;
let editorStore: typeof import('@renderer/stores/editor-store').editorStore;
let openIrisAgent: typeof import('@renderer/lib/iris-agent-actions').openIrisAgent;

const invoke = vi.fn();
let generation = 100;

beforeAll(async () => {
  vi.stubGlobal('window', {
    setInterval,
    clearInterval,
    api: { invoke, on: vi.fn() },
  });
  ({ editorStore } = await import('@renderer/stores/editor-store'));
  ({ projectStore } = await import('@renderer/stores/project-store'));
  ({ openIrisAgent } = await import('@renderer/lib/iris-agent-actions'));
});

function openProjectState(): ProjectScope {
  const scope: ProjectScope = { root: 'E:\\project-agent', generation: generation++ };
  const scan: IrisScanResult = {
    projectRoot: scope.root,
    projectName: 'project-agent',
    hasIris: true,
    root: {
      path: '.iris',
      name: 'project-agent',
      docs: [],
      children: [],
      archived: false,
    },
    scannedAt: 1,
  };
  projectStore.handleOpened({ scope, scan, sessions: [] });
  return scope;
}

function agentSession(scope: ProjectScope, id: string): IrisAgentSessionInfo {
  return {
    id,
    kind: 'iris-agent',
    anchor: { kind: 'workspace', path: '.iris' },
    model: null,
    projectRoot: scope.root,
    projectGeneration: scope.generation,
    displayName: 'Iris Agent',
    state: 'ready',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    currentIntentId: null,
    intents: [],
    terminals: [],
    canRewindLatestIntent: false,
    selfHostingEligible: false,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  invoke.mockReset();
  editorStore.closeSession();
  projectScopeState.set(null);
  projectScopeState.setSwitching(false);
  sessionViewStore.clear();
  irisAgentStore.reset([], null);
});

describe('openIrisAgent anchor navigation', () => {
  it('navigates to the root hub before creating a workspace Agent session', async () => {
    const scope = openProjectState();
    // Fresh project: the middle pane is still on the unfocused document view,
    // whose anchor key is null — the state the reported bug started from.
    expect(projectStore.get().view).toEqual({ kind: 'doc', path: null });
    const session = agentSession(scope, 'agent-1');
    invoke.mockImplementation((channel: string) =>
      channel === CHANNELS.IRIS_AGENT_OPEN
        ? Promise.resolve(session)
        : Promise.reject(new Error(`unexpected channel ${channel}`)),
    );

    await expect(
      openIrisAgent({ kind: 'workspace', path: '.iris' }),
    ).resolves.toEqual(session);

    expect(projectStore.get().view).toEqual({ kind: 'root' });
    expect(sessionViewStore.selected(scope, workspaceAnchorKey('.iris')))
      .toBe(irisAgentSessionKey('agent-1'));
    expect(irisAgentStore.get().sessions).toEqual([session]);
  });

  it('creates no session when navigation is rejected', async () => {
    openProjectState();
    vi.spyOn(projectStore, 'selectRoot').mockResolvedValue(false);

    await expect(
      openIrisAgent({ kind: 'workspace', path: '.iris' }),
    ).resolves.toBeNull();

    expect(projectStore.get().view).toEqual({ kind: 'doc', path: null });
    expect(invoke).not.toHaveBeenCalled();
    expect(irisAgentStore.get().sessions).toEqual([]);
  });
});
