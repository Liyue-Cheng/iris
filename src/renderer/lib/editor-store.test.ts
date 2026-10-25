import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  invoke: vi.fn(),
  behavior: {
    editorAutosave: true,
    editorAutosaveDelayMs: 1500,
    editorSaveOnBlur: true,
    editorConflictPolicy: 'ask' as 'ask' | 'overwrite',
  },
}));

vi.mock('@renderer/cpu', () => ({ pipeline: { dispatch: mocks.dispatch } }));
vi.mock('@renderer/stores/settings-store', () => ({
  getSettings: () => ({ behavior: mocks.behavior }),
}));

import { editorStore } from '@renderer/stores/editor-store';

const doc = (raw: string) => ({
  path: '.iris/issue/test.md',
  raw,
  body: raw,
  frontmatter: null,
  frontmatterBroken: false,
});

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('editorStore transaction coordinator', () => {
  beforeEach(() => {
    mocks.dispatch.mockReset();
    mocks.dispatch.mockResolvedValue(undefined);
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(doc('external\n'));
    vi.stubGlobal('window', { api: { invoke: mocks.invoke } });
    mocks.behavior.editorAutosave = true;
    mocks.behavior.editorAutosaveDelayMs = 1500;
    mocks.behavior.editorSaveOnBlur = true;
    mocks.behavior.editorConflictPolicy = 'ask';
    editorStore.closeSession();
    editorStore.openSession(doc('old\n'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    editorStore.closeSession();
  });

  it('ignores Crepe updates until hydration finishes', () => {
    const session = editorStore.get();
    expect(session).not.toBeNull();

    editorStore.setBodyFromEditor(session!.path, session!.generation, 'startup-normalized\n');
    expect(editorStore.get()?.dirty).toBe(false);

    editorStore.finishBodyHydration(session!.path, session!.generation, 'old\n');
    editorStore.setBodyFromEditor(session!.path, session!.generation, 'user edit\n');
    expect(editorStore.get()?.dirty).toBe(true);
  });

  it('never dispatches a clean save', async () => {
    const current = editorStore.get()!;
    editorStore.finishBodyHydration(current.path, current.generation, 'old\n');

    await expect(editorStore.save()).resolves.toEqual({ status: 'noop' });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('preserves a dirty WYSIWYG draft across a layout remount', () => {
    const current = editorStore.get()!;
    editorStore.finishBodyHydration(current.path, current.generation, 'old\n');
    editorStore.setBodyFromEditor(current.path, current.generation, 'draft\n');

    editorStore.prepareForRemount();

    const prepared = editorStore.get()!;
    expect(prepared).toMatchObject({
      originalBody: 'draft\n',
      bodyBaseline: null,
      bodyCurrent: null,
      bodyHydrating: true,
      dirty: true,
      generation: current.generation + 1,
    });

    editorStore.finishBodyHydration(prepared.path, prepared.generation, 'draft\n');
    expect(editorStore.get()).toMatchObject({
      bodyBaseline: 'draft\n',
      bodyCurrent: 'draft\n',
      bodyHydrating: false,
      dirty: true,
    });
  });

  it('serializes trailing saves with compare-and-swap baselines', async () => {
    mocks.behavior.editorAutosave = false;
    const current = editorStore.get()!;
    editorStore.finishBodyHydration(current.path, current.generation, 'old\n');
    const first = deferred();
    const second = deferred();
    mocks.dispatch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    editorStore.setBodyFromEditor(current.path, current.generation, 'first\n');
    const save = editorStore.save();
    expect(mocks.dispatch).toHaveBeenCalledWith('doc.save', {
      path: current.path,
      content: 'first\n',
      expectedContent: 'old\n',
    });

    editorStore.setBodyFromEditor(current.path, current.generation, 'second\n');
    void editorStore.save();
    first.resolve();
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(2));
    expect(mocks.dispatch).toHaveBeenLastCalledWith('doc.save', {
      path: current.path,
      content: 'second\n',
      expectedContent: 'first\n',
    });

    second.resolve();
    await save;
    expect(editorStore.get()).toMatchObject({ dirty: false, saving: false, saveError: null });
  });

  it('retries the newest queued revision when overwrite policy meets a conflict', async () => {
    mocks.behavior.editorAutosave = false;
    mocks.behavior.editorConflictPolicy = 'overwrite';
    const current = editorStore.get()!;
    editorStore.finishBodyHydration(current.path, current.generation, 'old\n');
    const first = deferred();
    mocks.dispatch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);

    editorStore.setBodyFromEditor(current.path, current.generation, 'first\n');
    const firstSave = editorStore.save();
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));

    editorStore.setBodyFromEditor(current.path, current.generation, 'latest\n');
    const latestSave = editorStore.save();
    first.reject(new Error('[ProjectManager] WriteConflict: changed'));

    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(2));
    expect(mocks.dispatch).toHaveBeenLastCalledWith('doc.save', {
      path: current.path,
      content: 'latest\n',
      expectedContent: null,
    });
    await expect(Promise.all([firstSave, latestSave])).resolves.toEqual([
      { status: 'saved' },
      { status: 'saved' },
    ]);
    expect(editorStore.get()).toMatchObject({ dirty: false, conflict: null, saving: false });
  });

  it('preserves source body edits when a frontmatter field commits', async () => {
    mocks.behavior.editorAutosave = false;
    const raw = '---\ntitle: old\n---\nbody\n';
    editorStore.openSession(doc(raw));
    editorStore.toggleMode();
    const current = editorStore.get()!;
    editorStore.setSourceText(
      current.path,
      current.generation,
      '---\ntitle: changed\n---\nsource body\n',
    );

    await editorStore.setFrontmatterField('status', 'In Progress');

    expect(mocks.dispatch).toHaveBeenCalledWith('doc.save', {
      path: current.path,
      content: '---\ntitle: changed\nstatus: In Progress\n---\nsource body\n',
      expectedContent: raw,
    });
    expect(editorStore.get()).toMatchObject({ dirty: false, mode: 'source' });
    const updated = editorStore.get()!;
    expect(updated.generation).toBe(current.generation + 1);
    // An update from the retired source editor must not undo the header edit.
    editorStore.setSourceText(current.path, current.generation, 'stale buffer');
    expect(editorStore.get()?.sourceText).toBe(updated.sourceText);
    editorStore.setSourceText(updated.path, updated.generation, `${updated.sourceText}next\n`);
    expect(editorStore.getFrontmatterField('status')).toBe('In Progress');
  });

  it('blocks conflict saves in ask mode and supports explicit overwrite', async () => {
    mocks.behavior.editorAutosave = false;
    const current = editorStore.get()!;
    editorStore.finishBodyHydration(current.path, current.generation, 'old\n');
    editorStore.setBodyFromEditor(current.path, current.generation, 'local\n');
    await editorStore.handleDiskChange(current.path, async () => doc('external\n'));

    await expect(editorStore.save()).resolves.toEqual({
      status: 'blocked',
      reason: 'external-conflict',
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();

    await expect(editorStore.overwriteConflict()).resolves.toEqual({ status: 'saved' });
    expect(mocks.dispatch).toHaveBeenCalledWith('doc.save', {
      path: current.path,
      content: 'local\n',
      expectedContent: null,
    });
    expect(editorStore.get()).toMatchObject({ dirty: false, conflict: null });
  });

  it('autosaves only after the configured idle delay', async () => {
    vi.useFakeTimers();
    const current = editorStore.get()!;
    editorStore.finishBodyHydration(current.path, current.generation, 'old\n');
    editorStore.setBodyFromEditor(current.path, current.generation, 'new\n');

    await vi.advanceTimersByTimeAsync(1499);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
  });

  it('keeps a failed revision dirty and visible', async () => {
    mocks.behavior.editorAutosave = false;
    const current = editorStore.get()!;
    editorStore.finishBodyHydration(current.path, current.generation, 'old\n');
    mocks.dispatch.mockRejectedValueOnce(new Error('disk full'));
    editorStore.setBodyFromEditor(current.path, current.generation, 'unsaved\n');

    await editorStore.save();

    expect(editorStore.get()).toMatchObject({
      dirty: true,
      saving: false,
      saveError: 'disk full',
    });
  });

  it('edits HTML head metadata surgically and saves the whole page', async () => {
    const page = '<html>\n<head>\n  <title>Old</title>\n</head>\n<body><p>keep</p></body>\n</html>\n';
    editorStore.openSession({ ...doc(page), path: '.iris/report/page.html' });
    expect(editorStore.get()).toMatchObject({ mode: 'source', htmlPreview: true, dirty: false });
    expect(editorStore.getFrontmatterField('title')).toBe('Old');

    await editorStore.setFrontmatterField('status', 'Backlog');

    const expected = page.replace('</head>', '  <meta name="iris:status" content="Backlog">\n</head>');
    expect(mocks.dispatch).toHaveBeenCalledWith('doc.save', {
      path: '.iris/report/page.html',
      content: expected,
      expectedContent: page,
    });
    expect(editorStore.get()).toMatchObject({ dirty: false, baselineRaw: expected });
    expect(editorStore.getFrontmatterField('status')).toBe('Backlog');
  });

  it('toggles an HTML session between preview and source, flushing before preview', async () => {
    mocks.behavior.editorAutosave = false;
    const page = '<html><head><title>T</title></head><body></body></html>';
    editorStore.openSession({ ...doc(page), path: '.iris/report/page.html' });

    editorStore.toggleMode();
    const source = editorStore.get()!;
    expect(source).toMatchObject({ htmlPreview: false, mode: 'source' });
    editorStore.setSourceText(source.path, source.generation, `${page}\n`);
    expect(editorStore.get()?.dirty).toBe(true);

    editorStore.toggleMode();
    await vi.waitFor(() => expect(editorStore.get()?.htmlPreview).toBe(true));
    await vi.waitFor(() =>
      expect(mocks.dispatch).toHaveBeenCalledWith('doc.save', {
        path: '.iris/report/page.html',
        content: `${page}\n`,
        expectedContent: page,
      }),
    );

    // A reload of the same document keeps the chosen view.
    editorStore.toggleMode();
    editorStore.openSession({ ...doc('<p>external</p>'), path: '.iris/report/page.html' });
    expect(editorStore.get()?.htmlPreview).toBe(false);
  });

  it('keeps the HTML draft visible while a save is pending or fails', async () => {
    mocks.behavior.editorAutosave = false;
    const page = '<head><title>T</title></head><body>old</body>';
    editorStore.openSession({ ...doc(page), path: '.iris/report/page.html' });
    editorStore.toggleMode();
    const source = editorStore.get()!;
    editorStore.setSourceText(source.path, source.generation, page.replace('old', 'draft'));
    const save = deferred();
    mocks.dispatch.mockReturnValueOnce(save.promise);

    editorStore.toggleMode();
    expect(editorStore.get()).toMatchObject({ htmlPreview: false, saving: true });
    save.reject(new Error('disk full'));
    await vi.waitFor(() => expect(editorStore.get()).toMatchObject({
      htmlPreview: false, dirty: true, saveError: 'disk full',
    }));
  });

  it('does not switch a different HTML document after an earlier save completes', async () => {
    mocks.behavior.editorAutosave = false;
    editorStore.openSession({ ...doc('<p>old</p>'), path: '.iris/report/first.html' });
    editorStore.toggleMode();
    const source = editorStore.get()!;
    editorStore.setSourceText(source.path, source.generation, '<p>draft</p>');
    const save = deferred();
    mocks.dispatch.mockReturnValueOnce(save.promise);
    editorStore.toggleMode();

    editorStore.openSession({ ...doc('<p>other</p>'), path: '.iris/report/other.html' });
    editorStore.toggleMode();
    save.resolve();
    await vi.waitFor(() => expect(editorStore.get()).toMatchObject({
      path: '.iris/report/other.html', htmlPreview: false, saving: false,
    }));
  });
});
