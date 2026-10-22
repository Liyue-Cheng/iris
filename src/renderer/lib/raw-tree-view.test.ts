import { describe, expect, it } from 'vitest';
import type { RawTreeNode } from '@shared/types';
import { projectRawTree } from './raw-tree-view';

function file(path: string, mtimeMs: number): RawTreeNode {
  return { name: path.split('/').pop()!, path, absolutePath: `C:/project/${path}`, kind: 'file', mtimeMs };
}

const root: RawTreeNode = {
  name: 'project', path: '', absolutePath: 'C:/project', kind: 'dir', mtimeMs: 0,
  children: [
    file('file10.ts', 100), file('file2.ts', 200), file('a.txt', 100),
    { ...file('src', 10), kind: 'dir', children: [file('src/main.ts', 50)] },
    { ...file('empty', 20), kind: 'dir', children: [] },
  ],
};

describe('file tree sorting and filtering', () => {
  it('sorts folders first and uses natural filename order without mutating the scan', () => {
    const before = JSON.stringify(root);
    expect(projectRawTree(root, 'alpha', '')?.children?.map((node) => node.name))
      .toEqual(['empty', 'src', 'a.txt', 'file2.ts', 'file10.ts']);
    expect(JSON.stringify(root)).toBe(before);
  });

  it('sorts each group newest first, resolving time ties by filename', () => {
    expect(projectRawTree(root, 'mtime', '')?.children?.map((node) => node.name))
      .toEqual(['empty', 'src', 'file2.ts', 'a.txt', 'file10.ts']);
  });

  it('retains ancestors for case-insensitive Windows-style relative paths', () => {
    const result = projectRawTree(root, 'alpha', ' SRC\\MAIN.TS ');
    expect(result?.children?.map((node) => node.path)).toEqual(['src']);
    expect(result?.children?.[0]?.children?.map((node) => node.path)).toEqual(['src/main.ts']);
  });

  it('retains matching folders and their contents, including empty folders', () => {
    expect(projectRawTree(root, 'alpha', 'src')?.children?.[0]?.children).toHaveLength(1);
    expect(projectRawTree(root, 'alpha', 'empty')?.children?.[0]?.path).toBe('empty');
    expect(projectRawTree(root, 'alpha', 'missing')).toBeNull();
    expect(projectRawTree(root, 'alpha', 'project')).toBeNull();
  });
});
