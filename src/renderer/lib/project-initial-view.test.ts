import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocContent, IrisScanResult, ProjectScope } from '@shared/types';
import { CHANNELS } from '@shared/protocol';

let projectStore: typeof import('@renderer/stores/project-store').projectStore;
let editorStore: typeof import('@renderer/stores/editor-store').editorStore;
let leftPanePrefs: typeof import('./left-pane-prefs').leftPanePrefs;
const invoke = vi.fn();
const scope: ProjectScope = { root: 'E:\\project-a', generation: 1 };

function scan(hasIris: boolean): IrisScanResult {
  return {
    projectRoot: scope.root,
    projectName: 'project-a',
    hasIris,
    root: hasIris ? {
      path: '.iris',
      name: 'project-a',
      docs: [],
      external: {
        workspacePath: '.iris',
        manifestPath: '.iris/external.txt',
        exists: false,
        entries: [],
        diagnostics: [],
      },
      children: [],
    } : null,
    scannedAt: 1,
  };
}

beforeEach(async () => {
  vi.resetModules();
  invoke.mockReset();
  vi.stubGlobal('window', { setInterval, clearInterval, api: { invoke, on: vi.fn() } });
  ({ projectStore } = await import('@renderer/stores/project-store'));
  ({ editorStore } = await import('@renderer/stores/editor-store'));
  ({ leftPanePrefs } = await import('./left-pane-prefs'));
});

describe('folder entry view', () => {
  it.each([true, false])('opens a new folder at the root hub (hasIris: %s)', (hasIris) => {
    projectStore.markOpening();
    projectStore.handleOpened({ scope, scan: scan(hasIris), sessions: [] });

    expect(projectStore.get()).toMatchObject({ phase: 'ready', view: { kind: 'root' } });
    expect(editorStore.get()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('restores an active project into the root hub on a fresh renderer', async () => {
    invoke.mockResolvedValue(scan(true));

    await projectStore.restoreActive(scope);

    expect(invoke).toHaveBeenCalledExactlyOnceWith(CHANNELS.PROJECT_SCAN, { expectedScope: scope });
    expect(projectStore.get()).toMatchObject({ phase: 'ready', view: { kind: 'root' } });
    expect(editorStore.get()).toBeNull();
  });

  it('opens the editor only after selecting a document and keeps it on an idempotent open', async () => {
    const result = { scope, scan: scan(true), sessions: [] };
    projectStore.handleOpened(result);
    const content: DocContent = {
      path: '.iris/issue/a.md',
      raw: '# a\n',
      body: '# a\n',
      frontmatter: null,
      frontmatterBroken: false,
    };
    invoke.mockResolvedValue(content);

    await expect(projectStore.selectDoc(content.path)).resolves.toBe(true);
    const selectedEditor = editorStore.get();
    expect(projectStore.get().view).toEqual({ kind: 'doc', path: content.path });
    expect(selectedEditor?.path).toBe(content.path);

    projectStore.handleOpened(result);

    expect(projectStore.get().view).toEqual({ kind: 'doc', path: content.path });
    expect(editorStore.get()).toBe(selectedEditor);

    projectStore.markOpening();
    const nextScope = { root: 'E:\\project-b', generation: 2 };
    projectStore.handleOpened({
      scope: nextScope,
      scan: { ...scan(false), projectRoot: nextScope.root, projectName: 'project-b' },
      sessions: [],
    });

    expect(projectStore.get()).toMatchObject({ phase: 'ready', scope: nextScope, view: { kind: 'root' } });
    expect(editorStore.get()).toBeNull();
  });

  it('reveals the selected document in collapsed left-pane sections', async () => {
    const projectScan = scan(true);
    const docPath = '.iris/issue/a.md';
    projectScan.root!.docs.push({
      path: docPath,
      name: 'a.md',
      type: 'issue',
      workspacePath: '.iris',
      title: null,
      status: 'Todo',
      frontmatter: null,
      frontmatterBroken: false,
      todos: [],
      mtimeMs: 1,
    });
    projectStore.handleOpened({ scope, scan: projectScan, sessions: [] });
    leftPanePrefs.setWorkspaceOpen(scope.root, '.iris', true, false);
    leftPanePrefs.setTypeOpen(scope.root, '.iris', 'issue', false);
    invoke.mockResolvedValue({
      path: docPath,
      raw: '# a\n',
      body: '# a\n',
      frontmatter: null,
      frontmatterBroken: false,
    } satisfies DocContent);

    await expect(projectStore.selectDoc(docPath)).resolves.toBe(true);

    expect(leftPanePrefs.workspaceOpen(scope.root, '.iris', true)).toBe(true);
    expect(leftPanePrefs.typeOpen(scope.root, '.iris', 'issue')).toBe(true);
  });
});
