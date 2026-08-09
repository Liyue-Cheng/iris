import { normalize, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  IrisScanResult,
  ProjectScope,
  ProjectSettingsSnapshot,
  SessionInfo,
} from '@shared/types';
import type { WindowContext } from './window-context';
import type { ProjectManager, PreparedProject } from './project-manager';
import type { GitManager } from './git-manager';
import type { SessionManager } from './session-manager';
import { enqueueProjectSwitch } from './project-switch';

function scan(root: string): IrisScanResult {
  return {
    projectRoot: root,
    projectName: root.split(/[\\/]/).at(-1) ?? root,
    hasIris: false,
    root: null,
    scannedAt: 1,
  };
}

function session(scope: ProjectScope): SessionInfo {
  return {
    id: 'session-a',
    docPath: null,
    workspacePath: '.iris',
    agentId: 'shell',
    displayName: 'Shell',
    terminalTitle: null,
    projectRoot: scope.root,
    projectGeneration: scope.generation,
    cols: 80,
    rows: 24,
    pid: 42,
    state: 'idle',
    createdAt: 1,
  };
}

function projectSettings(description = 'toolbar action'): ProjectSettingsSnapshot {
  return {
    settings: {
      version: 1,
    prompts: { project: '' },
    agentContext: { entries: ['AGENTS.md'] },
    toolbar: {
        actions: [{ icon: 'rocket', description, command: 'run', terminal: 'iris' }],
      },
    },
    revision: 'a'.repeat(64),
    exists: true,
    diagnostics: [],
    error: null,
    trusted: false,
  };
}

function harness(initial: ProjectScope | null, sessions: SessionInfo[] = []) {
  let managerRoot = initial?.root ?? null;
  const prepareOpen = vi.fn(async (root: string): Promise<PreparedProject> => ({
    root,
    scan: scan(root),
  }));
  const activatePrepared = vi.fn(async (prepared: PreparedProject) => {
    managerRoot = prepared.root;
    return prepared.scan;
  });
  const projectManager = {
    getRoot: () => managerRoot,
    scan: vi.fn(async () => scan(managerRoot!)),
    prepareOpen,
    activatePrepared,
  } as unknown as ProjectManager;
  const closeProject = vi.fn(async () => undefined);
  const sessionManager = {
    list: () => sessions,
    closeProject,
  } as unknown as SessionManager;
  const gitOpen = vi.fn(async () => undefined);
  const gitManager = { open: gitOpen } as unknown as GitManager;
  const readProjectSettings = vi.fn(async () => projectSettings());
  const ctx = {
    win: {} as WindowContext['win'],
    projectManager,
    sessionManager,
    gitManager,
    projectRoot: initial?.root ?? null,
    projectScope: initial,
    projectSwitching: false,
    projectSwitchTail: Promise.resolve(),
    unwire: () => undefined,
  } satisfies WindowContext;
  return {
    ctx,
    prepareOpen,
    activatePrepared,
    closeProject,
    gitOpen,
    readProjectSettings,
  };
}

describe('window project switching', () => {
  it('commits an initial project as generation 1', async () => {
    const h = harness(null);
    const committed = vi.fn();
    const target = normalize(resolve('project-b'));

    const result = await enqueueProjectSwitch(
      h.ctx,
      { root: target, expectedScope: null },
      committed,
      h.readProjectSettings,
    );

    expect(result.scope).toEqual({ root: target, generation: 1 });
    expect(h.closeProject).not.toHaveBeenCalled();
    expect(h.ctx.projectScope).toEqual(result.scope);
    expect(committed).toHaveBeenCalledWith(result.scope);
    expect(result.projectSettings.settings.toolbar.actions[0]?.description).toBe('toolbar action');
  });

  it('drains A before activating B and increments the generation', async () => {
    const rootA = normalize(resolve('project-a'));
    const rootB = normalize(resolve('project-b'));
    const scopeA = { root: rootA, generation: 4 };
    const h = harness(scopeA, [session(scopeA)]);
    const order: string[] = [];
    h.closeProject.mockImplementation(async () => {
      order.push('sessions');
    });
    h.activatePrepared.mockImplementation(async (prepared: PreparedProject) => {
      order.push('project');
      return prepared.scan;
    });
    h.gitOpen.mockImplementation(async () => {
      order.push('git');
    });
    h.readProjectSettings.mockImplementation(async () => {
      order.push('settings');
      return projectSettings();
    });

    const result = await enqueueProjectSwitch(
      h.ctx,
      { root: rootB, expectedScope: scopeA },
      () => order.push('commit'),
      h.readProjectSettings,
    );

    expect(order).toEqual(['sessions', 'project', 'git', 'commit', 'settings']);
    expect(result.scope).toEqual({ root: rootB, generation: 5 });
    expect(result.sessions).toEqual([]);
  });

  it('treats the same canonical root as an idempotent refresh', async () => {
    const root = normalize(resolve('project-a'));
    const scope = { root, generation: 3 };
    const existing = session(scope);
    const h = harness(scope, [existing]);

    const result = await enqueueProjectSwitch(
      h.ctx,
      { root, expectedScope: scope },
      vi.fn(),
      h.readProjectSettings,
    );

    expect(result.scope).toEqual(scope);
    expect(result.sessions).toEqual([existing]);
    expect(h.prepareOpen).not.toHaveBeenCalled();
    expect(h.closeProject).not.toHaveBeenCalled();
    expect(h.activatePrepared).not.toHaveBeenCalled();
  });

  it('preserves sessions when preflight resolves a path alias to the active root', async () => {
    const root = normalize(resolve('project-a'));
    const scope = { root, generation: 3 };
    const existing = session(scope);
    const h = harness(scope, [existing]);
    h.prepareOpen.mockResolvedValue({ root, scan: scan(root) });

    const result = await enqueueProjectSwitch(
      h.ctx,
      { root: resolve('project-a-link'), expectedScope: scope },
      vi.fn(),
      h.readProjectSettings,
    );

    expect(result.scope).toEqual(scope);
    expect(result.sessions).toEqual([existing]);
    expect(h.closeProject).not.toHaveBeenCalled();
    expect(h.activatePrepared).not.toHaveBeenCalled();
    expect(h.gitOpen).not.toHaveBeenCalled();
  });

  it('leaves A intact when B preflight fails', async () => {
    const root = normalize(resolve('project-a'));
    const scope = { root, generation: 2 };
    const h = harness(scope, [session(scope)]);
    h.prepareOpen.mockRejectedValue(new Error('cannot scan B'));

    await expect(
      enqueueProjectSwitch(
        h.ctx,
        { root: resolve('project-b'), expectedScope: scope },
        vi.fn(),
        h.readProjectSettings,
      ),
    ).rejects.toThrow('cannot scan B');

    expect(h.ctx.projectScope).toEqual(scope);
    expect(h.ctx.projectSwitching).toBe(false);
    expect(h.closeProject).not.toHaveBeenCalled();
  });

  it('rejects stale and queued switches against the committed generation', async () => {
    const rootA = normalize(resolve('project-a'));
    const rootB = normalize(resolve('project-b'));
    const rootC = normalize(resolve('project-c'));
    const scopeA = { root: rootA, generation: 1 };
    const h = harness(scopeA);

    const first = enqueueProjectSwitch(
      h.ctx,
      { root: rootB, expectedScope: scopeA },
      () => undefined,
      h.readProjectSettings,
    );
    const staleSecond = enqueueProjectSwitch(
      h.ctx,
      { root: rootC, expectedScope: scopeA },
      () => undefined,
      h.readProjectSettings,
    );

    await expect(first).resolves.toMatchObject({
      scope: { root: rootB, generation: 2 },
    });
    await expect(staleSecond).rejects.toThrow('stale project scope');
    expect(h.prepareOpen).toHaveBeenCalledTimes(1);
  });

  it('commits B when auxiliary Git setup or persistence fails after activation', async () => {
    const rootA = normalize(resolve('project-a'));
    const rootB = normalize(resolve('project-b'));
    const scopeA = { root: rootA, generation: 7 };
    const h = harness(scopeA, [session(scopeA)]);
    h.gitOpen.mockRejectedValue(new Error('git watcher unavailable'));

    const result = await enqueueProjectSwitch(
      h.ctx,
      { root: rootB, expectedScope: scopeA },
      () => {
        throw new Error('settings persistence unavailable');
      },
      h.readProjectSettings,
    );

    expect(h.closeProject).toHaveBeenCalledWith(scopeA);
    expect(result.scope).toEqual({ root: rootB, generation: 8 });
    expect(h.ctx.projectScope).toEqual(result.scope);
    expect(h.ctx.projectRoot).toBe(rootB);
    expect(h.ctx.projectSwitching).toBe(false);
  });
});
