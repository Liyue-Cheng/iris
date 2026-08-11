import { describe, expect, it } from 'vitest';
import type { IrisDoc, IrisWorkspace } from '@shared/types';
import { collectTodos } from './collect-docs';

function issue(name: string, status: string): IrisDoc {
  return {
    path: `.iris/issue/${name}.md`,
    name: `${name}.md`,
    type: 'issue',
    workspacePath: '.iris',
    title: name,
    status,
    frontmatter: { status },
    frontmatterBroken: false,
    todos: [{ line: 5, checked: false, text: `${name} task`, raw: `- [ ] ${name} task` }],
    mtimeMs: 1,
  };
}

function workspace(docs: IrisDoc[]): IrisWorkspace {
  return {
    path: '.iris',
    name: 'project',
    docs,
    children: [],
    archived: false,
  };
}

describe('active issue todo projection', () => {
  it('excludes On Hold and resolved issues while preserving soft active values', () => {
    const todos = collectTodos(
      workspace([
        issue('todo', 'Todo'),
        issue('hold', 'On Hold'),
        issue('done', 'Done'),
        issue('custom', 'Custom'),
      ]),
      null,
    );

    expect(todos.map((item) => item.doc.name)).toEqual(['todo.md', 'custom.md']);
  });
});
