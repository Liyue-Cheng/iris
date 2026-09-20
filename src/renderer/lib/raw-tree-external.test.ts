import { describe, expect, it } from 'vitest';
import type { ExternalPathEntry, IrisWorkspace } from '@shared/types';
import {
  collectExternalWorkspaces,
  externalTargetKey,
  indexExternalConnections,
} from './raw-tree-external';

function entry(path: string, line: number): ExternalPathEntry {
  return {
    storedPath: path,
    absolutePath: path,
    name: path.split(/[\\/]/).pop() ?? path,
    kind: 'file',
    exists: true,
    line,
    error: null,
  };
}

function workspace(
  path: string,
  name: string,
  entries: ExternalPathEntry[],
  children: IrisWorkspace[] = [],
): IrisWorkspace {
  return {
    path,
    name,
    docs: [],
    external: {
      workspacePath: path,
      manifestPath: `${path}/external.txt`,
      exists: true,
      entries,
      diagnostics: [],
    },
    children,
  };
}

describe('RawTree external connection projection', () => {
  it('indexes one project item against every workspace that references it', () => {
    const absolute = 'C:\\project\\src\\shared.ts';
    const child = workspace('.iris/spike', 'spike', [entry(absolute, 0)]);
    const root = workspace('.iris', 'project', [entry(absolute, 2)], [child]);
    const workspaces = collectExternalWorkspaces(root);

    const index = indexExternalConnections(workspaces, true);

    expect(index.get(externalTargetKey('c:\\PROJECT\\src\\shared.ts', true))).toEqual([
      expect.objectContaining({ workspacePath: '.iris', workspaceName: 'project' }),
      expect.objectContaining({ workspacePath: '.iris/spike', workspaceName: 'spike' }),
    ]);
  });

  it('ignores unavailable entries and preserves POSIX case sensitivity', () => {
    const missing = { ...entry('/repo/src/a.ts', 0), absolutePath: null, exists: false };
    const root = workspace('.iris', 'project', [missing, entry('/repo/src/A.ts', 1)]);

    const index = indexExternalConnections(collectExternalWorkspaces(root), false);

    expect(index.has('/repo/src/a.ts')).toBe(false);
    expect(index.get('/repo/src/A.ts')).toHaveLength(1);
  });
});
