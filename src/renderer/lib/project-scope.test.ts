import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DocContent,
  IrisDoc,
  IrisScanResult,
  ProjectScope,
  SessionInfo,
} from '@shared/types';
import { appISA } from '@renderer/cpu/isa/app-isa';
import { docISA } from '@renderer/cpu/isa/doc-isa';
import { PROJECT_SCOPE_RESOURCE } from '@renderer/cpu/isa/project-resources';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import {
  selectedSessionIdForAnchor,
  sessionStore,
  workspaceAnchorKey,
} from '@renderer/stores/session-store';

let projectISA: typeof import('@renderer/cpu/isa/project-isa').projectISA;
let editorStore: typeof import('@renderer/stores/editor-store').editorStore;
let projectStore: typeof import('@renderer/stores/project-store').projectStore;
const invoke = vi.fn();
let generation = 10;

beforeAll(async () => {
  vi.stubGlobal('window', {
    setInterval,
    clearInterval,
    api: { invoke, on: vi.fn() },
  });
  ({ editorStore } = await import('@renderer/stores/editor-store'));
  ({ projectStore } = await import('@renderer/stores/project-store'));
  ({ projectISA } = await import('@renderer/cpu/isa/project-isa'));
});

function session(
  scope: ProjectScope,
  id: string,
  overrides: Partial<SessionInfo> = {},
): SessionInfo {
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
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  invoke.mockReset();
  invoke.mockImplementation((_channel: string, payload: { path?: string }) =>
    Promise.resolve(docContent(payload.path ?? '.iris/issue/default.md')),
  );
  editorStore.closeSession();
  projectScopeState.set(null);
  projectScopeState.setSwitching(false);
  sessionStore.reset([], null);
});

function docContent(path: string): DocContent {
  return {
    path,
    raw: '# test\n',
    body: '# test\n',
    frontmatter: null,
    frontmatterBroken: false,
  };
}

function scanDoc(path: string, type: IrisDoc['type'], workspacePath = '.iris'): IrisDoc {
  return {
    path,
    name: path.split('/').pop()!,
    type,
    workspacePath,
    title: null,
    status: null,
    frontmatter: null,
    frontmatterBroken: false,
    todos: [],
    mtimeMs: 1,
  };
}

function openProjectState(docs: IrisDoc[] = []): ProjectScope {
  const scope = { root: 'E:\\project-a', generation: generation++ };
  const scan: IrisScanResult = {
    projectRoot: scope.root,
    projectName: 'project-a',
    hasIris: true,
    root: {
      path: '.iris',
      name: 'project-a',
      docs: docs.filter((doc) => doc.workspacePath === '.iris'),
      children: [
        {
          path: '.iris/spike',
          name: 'spike',
          docs: docs.filter((doc) => doc.workspacePath === '.iris/spike'),
          children: [],
          archived: false,
        },
      ],
      archived: false,
    },
    scannedAt: 1,
  };
  projectStore.handleOpened({ scope, scan, sessions: [] });
  return scope;
}

function deferredBoolean(): {
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
} {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

describe('session selection by anchor', () => {
  it('restores the selected terminal when returning to a document', () => {
    const scope = { root: 'E:\\project-a', generation: 2 };
    const docA = '.iris/issue/a.md';
    const docB = '.iris/issue/b.md';
    projectScopeState.set(scope);
    sessionStore.reset(
      [
        session(scope, 'a-1', { docPath: docA }),
        session(scope, 'a-2', { docPath: docA }),
        session(scope, 'b-1', { docPath: docB }),
        session(scope, 'b-2', { docPath: docB }),
      ],
      scope,
    );

    sessionStore.select('a-1');
    sessionStore.select('b-1');

    expect(selectedSessionIdForAnchor(docA)).toBe('a-1');
    expect(selectedSessionIdForAnchor(docB)).toBe('b-1');
  });

  it('forgets a remembered terminal after it is closed', () => {
    const scope = { root: 'E:\\project-a', generation: 2 };
    const docPath = '.iris/issue/a.md';
    projectScopeState.set(scope);
    sessionStore.reset(
      [
        session(scope, 'a-1', { docPath }),
        session(scope, 'a-2', { docPath }),
      ],
      scope,
    );

    sessionStore.select('a-1');
    sessionStore.handleDestroyed('a-1');

    expect(selectedSessionIdForAnchor(docPath)).toBe('a-2');
  });

  it('does not let lifecycle state changes steal an explicit selection', () => {
    const scope = { root: 'E:\\project-a', generation: 2 };
    const docPath = '.iris/issue/a.md';
    projectScopeState.set(scope);
    sessionStore.reset(
      [
        session(scope, 'a-1', { docPath }),
        session(scope, 'a-2', { docPath }),
      ],
      scope,
    );

    sessionStore.select('a-1');
    sessionStore.handlePatch('a-2', { state: 'active' });

    expect(selectedSessionIdForAnchor(docPath)).toBe('a-1');
  });

  it('does not let a newly created sibling steal an explicit selection', () => {
    const scope = { root: 'E:\\project-a', generation: 2 };
    const docPath = '.iris/issue/a.md';
    projectScopeState.set(scope);
    sessionStore.reset([session(scope, 'a-1', { docPath })], scope);
    sessionStore.select('a-1');

    sessionStore.handleCreated(session(scope, 'a-2', { docPath }));

    expect(selectedSessionIdForAnchor(docPath)).toBe('a-1');
  });

  it('moves an explicit selection with a re-anchored session', () => {
    const scope = { root: 'E:\\project-a', generation: 2 };
    const docPath = '.iris/issue/a.md';
    const workspacePath = '.iris/spike';
    projectScopeState.set(scope);
    sessionStore.reset([session(scope, 'a-1', { docPath })], scope);
    sessionStore.select('a-1');

    sessionStore.handlePatch('a-1', { docPath: null, workspacePath });

    expect(selectedSessionIdForAnchor(docPath)).toBeNull();
    expect(selectedSessionIdForAnchor(workspaceAnchorKey(workspacePath))).toBe('a-1');
  });

  it('clears anchor selections across project generations', () => {
    const first = { root: 'E:\\project-a', generation: 2 };
    const second = { root: 'E:\\project-b', generation: 3 };
    projectScopeState.set(first);
    sessionStore.reset([session(first, 'a-1')], first);
    sessionStore.select('a-1');

    projectScopeState.set(second);
    sessionStore.reset([session(second, 'b-1')], second);

    expect(sessionStore.get().selectedSessionIdByAnchor).toEqual({
      [workspaceAnchorKey('.iris')]: 'b-1',
    });
  });
});

describe('session activation transaction', () => {
  it('switches root sessions without a competing root synchronization', async () => {
    const scope = openProjectState();
    sessionStore.reset([session(scope, 'root-1'), session(scope, 'root-2')], scope);
    await projectStore.selectRoot();

    await expect(projectStore.activateSession('root-1')).resolves.toBe(true);

    expect(projectStore.get().view).toEqual({ kind: 'root' });
    expect(selectedSessionIdForAnchor(workspaceAnchorKey('.iris'))).toBe('root-1');
  });

  it('uses the same activation transaction for a sub-workspace', async () => {
    const scope = openProjectState();
    const workspacePath = '.iris/spike';
    sessionStore.reset(
      [session(scope, 'workspace-1', { workspacePath })],
      scope,
    );

    await expect(projectStore.activateSession('workspace-1')).resolves.toBe(true);

    expect(projectStore.get().view).toEqual({ kind: 'workspace', path: workspacePath });
    expect(selectedSessionIdForAnchor(workspaceAnchorKey(workspacePath))).toBe('workspace-1');
  });

  it('changes neither view nor selection when leaving the editor is rejected', async () => {
    const scope = openProjectState();
    const docPath = '.iris/issue/a.md';
    sessionStore.reset(
      [session(scope, 'doc-1', { docPath }), session(scope, 'root-1')],
      scope,
    );
    await projectStore.selectDoc(docPath);
    sessionStore.select('doc-1');
    const rootSelectionBefore = selectedSessionIdForAnchor(workspaceAnchorKey('.iris'));
    vi.spyOn(editorStore, 'flushBeforeSwitch').mockResolvedValue(false);

    await expect(projectStore.activateSession('root-1')).resolves.toBe(false);

    expect(projectStore.get().view).toEqual({ kind: 'doc', path: docPath });
    expect(selectedSessionIdForAnchor(docPath)).toBe('doc-1');
    expect(selectedSessionIdForAnchor(workspaceAnchorKey('.iris'))).toBe(rootSelectionBefore);
  });

  it('keeps the latest intent when an older navigation gate resolves later', async () => {
    const scope = openProjectState();
    const docPath = '.iris/issue/a.md';
    sessionStore.reset(
      [
        session(scope, 'doc-1', { docPath }),
        session(scope, 'doc-2', { docPath }),
        session(scope, 'root-1'),
      ],
      scope,
    );
    await projectStore.selectDoc(docPath);
    sessionStore.select('doc-1');
    const gate = deferredBoolean();
    vi.spyOn(editorStore, 'flushBeforeSwitch').mockReturnValue(gate.promise);

    const staleActivation = projectStore.activateSession('root-1');
    await projectStore.activateSession('doc-2');
    gate.resolve(true);

    await expect(staleActivation).resolves.toBe(false);
    expect(projectStore.get().view).toEqual({ kind: 'doc', path: docPath });
    expect(selectedSessionIdForAnchor(docPath)).toBe('doc-2');
  });
});

describe('document collection navigation', () => {
  it('restores the Todo main page after leaving a collection', async () => {
    openProjectState([scanDoc('.iris/issue/a.md', 'issue')]);
    await projectStore.openTodos('.iris/spike');

    await expect(projectStore.openCollection('issue', null)).resolves.toBe(true);
    expect(projectStore.get().view).toMatchObject({
      kind: 'collection',
      type: 'issue',
      returnTo: { kind: 'todos', workspacePath: '.iris/spike' },
    });

    await expect(projectStore.leaveCollection()).resolves.toBe(true);
    expect(projectStore.get().view).toEqual({ kind: 'todos', workspacePath: '.iris/spike' });
  });

  it('restores the source document and workspace hub exactly', async () => {
    const source = scanDoc('.iris/spike/issue/source.md', 'issue', '.iris/spike');
    openProjectState([source]);
    await projectStore.selectDoc(source.path);
    await projectStore.openCollection('report', null);
    await projectStore.leaveCollection();
    expect(projectStore.get().view).toEqual({ kind: 'doc', path: source.path });
    expect(editorStore.get()?.path).toBe(source.path);

    await projectStore.selectWorkspace('.iris/spike');
    await projectStore.openCollection('status', '.iris/spike');
    await projectStore.leaveCollection();
    expect(projectStore.get().view).toEqual({ kind: 'workspace', path: '.iris/spike' });
  });

  it('does not enter or leave a collection when the editor refuses the switch', async () => {
    const issue = scanDoc('.iris/issue/a.md', 'issue');
    openProjectState([issue]);
    await projectStore.selectRoot();
    vi.spyOn(editorStore, 'flushBeforeSwitch').mockResolvedValue(false);

    await expect(projectStore.openCollection('issue', null)).resolves.toBe(false);
    expect(projectStore.get().view).toEqual({ kind: 'root' });

    vi.mocked(editorStore.flushBeforeSwitch).mockResolvedValue(true);
    await projectStore.openCollection('issue', null);
    vi.mocked(editorStore.flushBeforeSwitch).mockResolvedValue(false);
    await expect(projectStore.leaveCollection()).resolves.toBe(false);
    expect(projectStore.get().view).toMatchObject({ kind: 'collection', type: 'issue' });
  });

  it('keeps the original main-page target when changing collection type', async () => {
    openProjectState([
      scanDoc('.iris/issue/a.md', 'issue'),
      scanDoc('.iris/report/a.md', 'report'),
    ]);
    await projectStore.selectRoot();
    await projectStore.openCollection('issue', null);

    await expect(projectStore.openCollection('report', null)).resolves.toBe(true);
    expect(projectStore.get().view).toMatchObject({
      kind: 'collection',
      type: 'report',
      returnTo: { kind: 'root' },
    });

    await projectStore.leaveCollection();
    expect(projectStore.get().view).toEqual({ kind: 'root' });
  });

  it('selects only documents matching the collection type and workspace scope', async () => {
    const rootIssue = scanDoc('.iris/issue/a.md', 'issue');
    const rootReport = scanDoc('.iris/report/a.md', 'report');
    const nestedIssue = scanDoc('.iris/spike/issue/a.md', 'issue', '.iris/spike');
    openProjectState([rootIssue, rootReport, nestedIssue]);
    await projectStore.openCollection('issue', '.iris');

    await expect(projectStore.selectCollectionDoc(rootReport.path)).resolves.toBe(false);
    await expect(projectStore.selectCollectionDoc(nestedIssue.path)).resolves.toBe(false);
    await expect(projectStore.selectCollectionDoc(rootIssue.path)).resolves.toBe(true);
    expect(projectStore.get().view).toMatchObject({
      kind: 'collection',
      type: 'issue',
      workspacePath: '.iris',
      selectedPath: rootIssue.path,
    });
  });

  it('remembers selection per type and opens the selected document in the main shell', async () => {
    const issue = scanDoc('.iris/issue/a.md', 'issue');
    const report = scanDoc('.iris/report/a.md', 'report');
    openProjectState([issue, report]);
    await projectStore.openCollection('issue', null);
    await projectStore.selectCollectionDoc(issue.path);
    await projectStore.openCollection('report', null);
    await projectStore.selectCollectionDoc(report.path);

    await projectStore.openCollection('issue', null);
    expect(projectStore.get().view).toMatchObject({ selectedPath: issue.path });
    await expect(projectStore.openCollectionDocInDefaultView()).resolves.toBe(true);
    expect(projectStore.get().view).toEqual({ kind: 'doc', path: issue.path });
    expect(editorStore.get()?.path).toBe(issue.path);
  });

  it('falls back to the source workspace when the return document disappears', async () => {
    const source = scanDoc('.iris/spike/issue/source.md', 'issue', '.iris/spike');
    const report = scanDoc('.iris/report/a.md', 'report');
    openProjectState([source, report]);
    await projectStore.selectDoc(source.path);
    await projectStore.openCollection('report', null);

    const scan = projectStore.get().scan!;
    const spike = scan.root!.children[0]!;
    spike.docs = [];
    await expect(projectStore.leaveCollection()).resolves.toBe(true);
    expect(projectStore.get().view).toEqual({ kind: 'workspace', path: '.iris/spike' });
  });

  it('falls back to the root hub when the return workspace disappears', async () => {
    openProjectState([]);
    await projectStore.selectWorkspace('.iris/spike');
    await projectStore.openCollection('issue', '.iris/spike');

    projectStore.get().scan!.root!.children = [];
    await expect(projectStore.leaveCollection()).resolves.toBe(true);
    expect(projectStore.get().view).toEqual({ kind: 'root' });
  });
});
