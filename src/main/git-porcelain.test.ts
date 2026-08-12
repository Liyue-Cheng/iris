import { describe, expect, it } from 'vitest';
import { parseGitPorcelainV1Z } from './git-porcelain';

describe('parseGitPorcelainV1Z', () => {
  it('projects both columns of a two-layer status', () => {
    const parsed = parseGitPorcelainV1Z('## main...origin/main [ahead 2, behind 1]\0MM src/a.ts\0MD src/b.ts\0');

    expect(parsed).toMatchObject({ branch: 'main', detached: false, ahead: 2, behind: 1 });
    expect(parsed.groups.index.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(parsed.groups.workingTree.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('consumes rename and copy source paths without creating phantom resources', () => {
    const parsed = parseGitPorcelainV1Z('## main\0R  new name.ts\0old name.ts\0 C copied.ts\0source.ts\0?? loose file\0');

    expect(parsed.groups.index).toEqual([{
      path: 'new name.ts',
      originalPath: 'old name.ts',
      status: 'R ',
      group: 'index',
    }]);
    expect(parsed.groups.workingTree).toEqual([{
      path: 'copied.ts',
      originalPath: 'source.ts',
      status: ' C',
      group: 'workingTree',
    }]);
    expect(parsed.groups.untracked[0]?.path).toBe('loose file');
  });

  it('keeps conflicts in a single merge group', () => {
    const parsed = parseGitPorcelainV1Z('## main\0UU conflict.txt\0AA both-added.txt\0');
    expect(parsed.groups.merge.map((entry) => entry.status)).toEqual(['UU', 'AA']);
    expect(parsed.groups.index).toEqual([]);
    expect(parsed.groups.workingTree).toEqual([]);
  });

  it('parses unborn and detached branch headers', () => {
    expect(parseGitPorcelainV1Z('## No commits yet on trunk\0').branch).toBe('trunk');
    expect(parseGitPorcelainV1Z('## Initial commit on topic\0').branch).toBe('topic');
    expect(parseGitPorcelainV1Z('## HEAD (no branch)\0')).toMatchObject({ branch: null, detached: true });
  });

  it('does not include a deleted upstream marker in the branch name', () => {
    expect(parseGitPorcelainV1Z('## topic...origin/topic [gone]\0')).toMatchObject({
      branch: 'topic',
      ahead: 0,
      behind: 0,
    });
  });

  it('preserves special and non-ASCII path bytes represented as JavaScript text', () => {
    const path = '目录/line\n"quoted" - file.ts';
    const parsed = parseGitPorcelainV1Z(`## main\0?? ${path}\0`);
    expect(parsed.groups.untracked[0]?.path).toBe(path);
  });
});
