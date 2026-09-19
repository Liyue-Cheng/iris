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
let sendIrisAgentMessage: typeof import('@renderer/lib/iris-agent-actions').sendIrisAgentMessage;

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
  ({ openIrisAgent, sendIrisAgentMessage } = await import('@renderer/lib/iris-agent-actions'));
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
      external: { workspacePath: '.iris', manifestPath: '.iris/external.txt', exists: false, entries: [], diagnostics: [] },
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
    workerEpoch: 0,
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

describe('sendIrisAgentMessage outcome', () => {
  it('returns false on IPC failure so the composer can retain its draft', async () => {
    const scope = openProjectState();
    const session = agentSession(scope, 'agent-send-failed');
    session.model = { provider: 'openai', modelId: 'gpt-test' };
    irisAgentStore.reset([session], scope);
    vi.spyOn(editorStore, 'flushBeforeSwitch').mockResolvedValue(true);
    invoke.mockRejectedValue(new Error('send failed'));

    await expect(sendIrisAgentMessage(session.id, 'keep me', [{
      name: 'shot.png', dataBase64: 'AAAA',
    }])).resolves.toBe(false);
  });

  it('returns true only after main accepts the request', async () => {
    const scope = openProjectState();
    const session = agentSession(scope, 'agent-send-ok');
    session.model = { provider: 'openai', modelId: 'gpt-test' };
    irisAgentStore.reset([session], scope);
    vi.spyOn(editorStore, 'flushBeforeSwitch').mockResolvedValue(true);
    invoke.mockResolvedValue({ ...session, revision: session.revision + 1, state: 'starting' });

    const sent = await sendIrisAgentMessage(session.id, 'send me');
    expect(invoke).toHaveBeenCalledWith(CHANNELS.IRIS_AGENT_SEND, expect.any(Object));
    expect(sent).toBe(true);
  });
});
