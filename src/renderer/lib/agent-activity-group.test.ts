import { describe, expect, it } from 'vitest';
import type { IrisAgentCardView, IrisAgentLocalRetrievalItemView } from '@shared/types';
import {
  buildActivityRows,
  diffLineStats,
  fileActionLabel,
  groupAgentCards,
  summarizeActivityRows,
  type FileChangeAction,
  type TrivialCard,
} from './agent-activity-group';

function fileItem(id: string, label: string): IrisAgentLocalRetrievalItemView {
  return { id, kind: 'file', label, state: 'completed' };
}

function queryItem(id: string, label: string): IrisAgentLocalRetrievalItemView {
  return { id, kind: 'query', label, state: 'completed' };
}

function retrieval(
  id: string,
  items: IrisAgentLocalRetrievalItemView[],
): Extract<IrisAgentCardView, { kind: 'local-retrieval' }> {
  return { kind: 'local-retrieval', id, state: 'completed', items };
}

function fileChange(
  id: string,
  overrides: Partial<Extract<IrisAgentCardView, { kind: 'file-change' }>> = {},
): Extract<IrisAgentCardView, { kind: 'file-change' }> {
  return {
    kind: 'file-change',
    id,
    state: 'completed',
    path: `src/${id}.ts`,
    tool: 'edit',
    action: 'updated',
    ...overrides,
  };
}

function reply(id: string): IrisAgentCardView {
  return { kind: 'agent-reply', id, state: 'completed', content: 'done', excludedFromContext: false };
}

function command(id: string): IrisAgentCardView {
  return {
    kind: 'terminal-operation', id, state: 'completed', command: 'npm test', cwd: '.',
  };
}

function trivial(cards: IrisAgentCardView[]): TrivialCard[] {
  return cards as TrivialCard[];
}

describe('groupAgentCards', () => {
  it('folds consecutive trivial cards into one group', () => {
    const groups = groupAgentCards([
      retrieval('r1', [fileItem('i1', 'a.ts'), fileItem('i2', 'b.ts')]),
      fileChange('f1'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'activity-group' });
    if (groups[0]?.kind !== 'activity-group') throw new Error('expected a group');
    expect(groups[0].cards.map((card) => card.id)).toEqual(['r1', 'f1']);
  });

  it('ends a group at any card that keeps its own frame', () => {
    const groups = groupAgentCards([
      retrieval('r1', [fileItem('i1', 'a.ts')]),
      command('c1'),
      retrieval('r2', [fileItem('i2', 'b.ts')]),
      reply('m1'),
      fileChange('f1'),
    ]);
    expect(groups.map((group) => group.kind)).toEqual([
      'activity-group', 'single', 'activity-group', 'single', 'activity-group',
    ]);
  });

  it('starts a new group when the run is only broken by a non-trivial card', () => {
    const groups = groupAgentCards([
      fileChange('f1'),
      reply('m1'),
      fileChange('f2'),
    ]);
    expect(groups).toHaveLength(3);
  });
});

describe('buildActivityRows', () => {
  it('gives a file change one row carrying its tool, action and diff line counts', () => {
    const rows = buildActivityRows(trivial([
      fileChange('f1', {
        tool: 'write',
        action: 'created',
        diff: '--- a\n+++ b\n@@ -0,0 +1,2 @@\n+one\n+two\n',
      }),
    ]));
    expect(rows).toEqual([{
      id: 'f1',
      label: 'src/f1.ts',
      state: 'completed',
      error: undefined,
      terminalId: undefined,
      family: 'file-change',
      tool: 'write',
      action: 'created',
      additions: 2,
      deletions: 0,
    }]);
  });

  it('gives each retrieval item its own row and keeps the item order', () => {
    const rows = buildActivityRows(trivial([
      retrieval('r1', [fileItem('i1', 'a.ts'), queryItem('i2', 'git status')]),
    ]));
    expect(rows.map((row) => [row.family, row.tool, row.label])).toEqual([
      ['read', 'read', 'a.ts'],
      ['query', 'terminal', 'git status'],
    ]);
    expect(rows.map((row) => row.id)).toEqual(['r1-i1', 'r1-i2']);
  });

  it('carries the terminal id of a failed retrieval item so the row stays clickable', () => {
    const rows = buildActivityRows(trivial([
      retrieval('r1', [{
        id: 'i1', kind: 'query', label: 'npm run build', state: 'failed',
        error: 'exit 1', terminalId: 't1',
      }]),
    ]));
    expect(rows[0]).toMatchObject({ state: 'failed', terminalId: 't1', error: 'exit 1' });
  });
});

describe('summarizeActivityRows', () => {
  it('counts each tool and the errors, one row at a time', () => {
    const rows = buildActivityRows(trivial([
      retrieval('r1', [fileItem('i1', 'a.ts'), fileItem('i2', 'b.ts'), fileItem('i3', 'c.ts')]),
      retrieval('r2', [queryItem('i4', 'git status'), queryItem('i5', 'git log')]),
      fileChange('f1'),
      fileChange('f2', { state: 'failed', action: 'attempted' }),
    ]));
    expect(summarizeActivityRows(rows)).toBe('3读取 · 2信息 · 2编辑 · 1错误');
  });

  it('still reports the read count when nothing else happened', () => {
    const rows = buildActivityRows(trivial([
      retrieval('r1', [fileItem('i1', 'a.ts'), fileItem('i2', 'b.ts')]),
    ]));
    expect(summarizeActivityRows(rows)).toBe('2读取 · 0信息 · 0编辑 · 0错误');
  });
});

describe('fileActionLabel', () => {
  it('names every action, with the unrecognised result reading as a failed write', () => {
    const actions: FileChangeAction[] = ['created', 'updated', 'unchanged', 'attempted'];
    expect(actions.map(fileActionLabel)).toEqual([
      '创建', '修改', '未改变', '写入失败',
    ]);
  });
});

describe('diffLineStats', () => {
  it('ignores the file headers and counts only changed lines', () => {
    expect(diffLineStats('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n')).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it('reports nothing for a change with no diff', () => {
    expect(diffLineStats(undefined)).toEqual({ additions: 0, deletions: 0 });
  });
});
