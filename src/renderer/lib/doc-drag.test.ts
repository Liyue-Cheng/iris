import { describe, expect, it, vi } from 'vitest';
import {
  IRIS_DOC_MIME,
  formatDroppedPaths,
  governEditorPathDrop,
  isEditorPathDrag,
  resolveEditorPathDrop,
  resolveSystemFilePaths,
} from './doc-drag';

function dataTransfer({
  types = [],
  data = {},
  files = [],
}: {
  types?: string[];
  data?: Record<string, string>;
  files?: File[];
}): DataTransfer {
  return {
    types,
    files,
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer;
}

function file(name: string): File {
  return { name } as File;
}

describe('editor path drop governance', () => {
  it('prioritizes the Iris document MIME and preserves its relative path', () => {
    const dt = dataTransfer({
      types: [IRIS_DOC_MIME, 'Files'],
      data: { [IRIS_DOC_MIME]: '.iris/issue/带 空格.md' },
      files: [file('ignored.txt')],
    });
    const resolvePath = vi.fn(() => 'E:\\ignored.txt');

    expect(resolveEditorPathDrop(dt, resolvePath)).toEqual({
      source: 'iris-document',
      paths: ['.iris/issue/带 空格.md'],
    });
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it('resolves OS files in drag order and filters empty or failed paths', () => {
    const first = file('one.txt');
    const missing = file('missing.bin');
    const failed = file('failed.bin');
    const last = file('中文 two.png');
    const paths = new Map<File, string>([
      [first, 'E:\\one.txt'],
      [missing, ''],
      [last, 'E:\\目录\\中文 two.png'],
    ]);
    const resolvePath = (value: File): string => {
      if (value === failed) throw new Error('not OS-backed');
      return paths.get(value) ?? '';
    };

    expect(
      resolveEditorPathDrop(
        dataTransfer({ types: ['Files'], files: [first, missing, failed, last] }),
        resolvePath,
      ),
    ).toEqual({
      source: 'system-file',
      paths: ['E:\\one.txt', 'E:\\目录\\中文 two.png'],
    });
  });

  it('marks unresolved file drops as governed instead of falling through', () => {
    const dt = dataTransfer({ types: ['Files'], files: [file('virtual.bin')] });

    expect(isEditorPathDrag(dt)).toBe(true);
    expect(resolveEditorPathDrop(dt, () => '')).toEqual({
      source: 'system-file',
      paths: [],
    });
  });

  it('leaves ordinary text and URL drags to the active editor', () => {
    const dt = dataTransfer({
      types: ['text/plain', 'text/uri-list'],
      data: { 'text/plain': 'ordinary text' },
    });

    expect(isEditorPathDrag(dt)).toBe(false);
    expect(resolveEditorPathDrop(dt, vi.fn())).toBeNull();
  });

  it('shares system path resolution and one-path-per-line formatting', () => {
    const files = [file('first'), file('second')];
    const paths = resolveSystemFilePaths(files, (value) =>
      value === files[0] ? 'C:\\Program Files\\first.md' : 'C:\\资料\\second.bin',
    );

    expect(formatDroppedPaths(paths)).toBe(
      'C:\\Program Files\\first.md\nC:\\资料\\second.bin',
    );
  });

  it('prevents default file semantics without blocking indicator cleanup propagation', () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const focus = vi.fn();
    const insertTextAtPoint = vi.fn(() => true);
    const event = {
      dataTransfer: dataTransfer({
        types: [IRIS_DOC_MIME],
        data: { [IRIS_DOC_MIME]: '.iris/issue/drop.md' },
      }),
      clientX: 120,
      clientY: 240,
      preventDefault,
      stopPropagation,
    };

    expect(
      governEditorPathDrop(event, vi.fn(), { focus, insertTextAtPoint }),
    ).toBe('inserted');
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(insertTextAtPoint).toHaveBeenCalledWith('.iris/issue/drop.md', {
      x: 120,
      y: 240,
    });
  });
});
