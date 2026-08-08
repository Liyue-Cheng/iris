import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectScope, SessionInfo } from '@shared/types';
import { appISA } from '@renderer/cpu/isa/app-isa';
import { docISA } from '@renderer/cpu/isa/doc-isa';
import { PROJECT_SCOPE_RESOURCE } from '@renderer/cpu/isa/project-resources';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import { sessionStore } from '@renderer/stores/session-store';

let projectISA: typeof import('@renderer/cpu/isa/project-isa').projectISA;

beforeAll(async () => {
  vi.stubGlobal('window', {
    setInterval,
    clearInterval,
    api: { invoke: vi.fn(), on: vi.fn() },
  });
  ({ projectISA } = await import('@renderer/cpu/isa/project-isa'));
});

function session(scope: ProjectScope, id: string): SessionInfo {
  return {
    id,
    docPath: null,
    workspacePath: '.iris',
    agentId: 'shell',
    displayName: 'Shell',
    terminalTitle: null,
    projectRoot: scope.root,
    projectGeneration: scope.generation,
    cols: 80,
    rows: 24,
    pid: 1,
    state: 'idle',
    createdAt: 1,
  };
}

beforeEach(() => {
  projectScopeState.set(null);
  projectScopeState.setSwitching(false);
  sessionStore.reset([], null);
});

describe('project scope boundary', () => {
  it('gives project.open a write lock and project mutations a read lock', () => {
    const switchResources = projectISA['project.open']!.meta.resourceIdentifier({ root: 'B' });
    const saveResources = docISA['doc.save']!.meta.resourceIdentifier({ path: '.iris/issue/a.md' });

    expect(switchResources).toContainEqual({ id: PROJECT_SCOPE_RESOURCE, mode: 'write' });
    expect(saveResources).toContainEqual({ id: PROJECT_SCOPE_RESOURCE, mode: 'read' });
    expect(
      appISA['shell.reveal-project-item']!.meta.resourceIdentifier({
        path: '.iris/issue/a.md',
      }),
    ).toContainEqual({ id: PROJECT_SCOPE_RESOURCE, mode: 'read' });
    expect(
      appISA['shell.open-project-item']!.meta.resourceIdentifier({
        path: '.iris/issue/a.md',
      }),
    ).toContainEqual({ id: PROJECT_SCOPE_RESOURCE, mode: 'read' });
    expect(projectISA['window.open-project']).toBeDefined();
  });

  it('filters a session snapshot by both root and generation', () => {
    const current = { root: 'E:\\project-a', generation: 2 };
    const stale = { root: current.root, generation: 1 };
    projectScopeState.set(current);

    sessionStore.reset(
      [session(stale, 'stale'), session(current, 'current')],
      current,
    );

    expect(sessionStore.get().sessions.map((item) => item.id)).toEqual(['current']);
  });

  it('rejects a created session from an old generation', () => {
    const current = { root: 'E:\\project-a', generation: 2 };
    projectScopeState.set(current);
    sessionStore.reset([], current);

    sessionStore.handleCreated(session({ ...current, generation: 1 }, 'stale'));

    expect(sessionStore.get().sessions).toEqual([]);
  });
});
