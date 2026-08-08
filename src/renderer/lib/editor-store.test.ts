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
});
