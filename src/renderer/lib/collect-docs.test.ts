import { describe, expect, it } from 'vitest';
import type { IrisDoc, IrisWorkspace } from '@shared/types';
import { collectDocs, collectTodos } from './collect-docs';

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

function workspace(docs: IrisDoc[], path = '.iris'): IrisWorkspace {
  return {
    path,
    name: 'project',
    docs: docs.map((doc) => ({ ...doc, path: `${path}/issue/${doc.name}`, workspacePath: path })),
    external: { workspacePath: path, manifestPath: `${path}/external.txt`, exists: false, entries: [], diagnostics: [] },
    children: [],
  };
}

describe('active issue todo projection', () => {
  it('includes active tasks in report-nested workspaces and keeps each workspace scope independent', () => {
    const root = workspace([]);
    const child = workspace([issue('todo', 'Todo'), issue('done', 'Done')], '.iris/report/project');
    const nested = workspace([issue('nested', 'In Progress')], `${child.path}/child`);
    root.children.push(child);
    child.children.push(nested);

    expect(collectTodos(root, null).map((item) => item.doc.path)).toEqual([
      `${child.path}/issue/todo.md`,
      `${nested.path}/issue/nested.md`,
    ]);
    expect(collectTodos(root, child.path).map((item) => item.doc.name)).toEqual(['todo.md']);
    expect(collectDocs(root, 'issue', child.path).map((item) => item.doc.name)).toEqual(['todo.md', 'done.md']);
  });

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
