import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock('@renderer/cpu', () => ({
  pipeline: { dispatch },
}));

import { editorStore } from '@renderer/stores/editor-store';

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

describe('editorStore save queue', () => {
  beforeEach(() => {
    dispatch.mockReset();
    editorStore.closeSession();
    editorStore.openSession({
      path: '.iris/issue/test.md',
      raw: 'old\n',
      body: 'old\n',
      frontmatter: null,
      frontmatterBroken: false,
    });
    editorStore.setBodyBaseline('old\n');
  });

  it('trails edits made while a save is in flight and only cleans the latest revision', async () => {
    const first = deferred();
    const second = deferred();
    dispatch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    editorStore.setBody('first\n');
    const save = editorStore.save();
    expect(dispatch).toHaveBeenCalledWith('doc.save', {
      path: '.iris/issue/test.md',
      content: 'first\n',
    });

    editorStore.setBody('second\n');
    void editorStore.save();
    first.resolve();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch).toHaveBeenLastCalledWith('doc.save', {
      path: '.iris/issue/test.md',
      content: 'second\n',
    });
    expect(editorStore.get()?.dirty).toBe(true);

    second.resolve();
    await save;
    expect(editorStore.get()).toMatchObject({ dirty: false, saving: false, saveError: null });
  });

  it('keeps the current revision dirty and visible when writing fails', async () => {
    dispatch.mockRejectedValueOnce(new Error('disk full'));
    editorStore.setBody('unsaved\n');

    await editorStore.save();

    expect(editorStore.get()).toMatchObject({
      dirty: true,
      saving: false,
      saveError: 'disk full',
    });
  });
});
