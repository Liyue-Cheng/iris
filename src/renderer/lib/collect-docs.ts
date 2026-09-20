/**
 * Flatten the workspace tree into collection-view rows. Pure projection
 * helpers — deterministic, no fs access.
 */
import type { DocTodo, DocType, IrisDoc, IrisWorkspace } from '@shared/types';
import { isActiveIssue } from './doc-utils';

export interface CollectedDoc {
  doc: IrisDoc;
  /** Display name of the owning workspace ("项目名" for the root). */
  workspaceName: string;
  workspacePath: string;
}

export function collectDocs(
  root: IrisWorkspace,
  type: DocType,
  workspacePath: string | null,
): CollectedDoc[] {
  const out: CollectedDoc[] = [];
  const walk = (ws: IrisWorkspace): void => {
    if (workspacePath === null || ws.path === workspacePath) {
      for (const doc of ws.docs) {
        if (doc.type === type) {
          out.push({ doc, workspaceName: ws.name, workspacePath: ws.path });
        }
      }
    }
    // When scoped to one workspace, nested workspaces are separate scopes —
    // don't recurse past the match (生死同域: a sub-workspace owns its docs).
    if (workspacePath === null || ws.path !== workspacePath) {
      for (const child of ws.children) walk(child);
    }
  };
  walk(root);
  return out;
}

export interface CollectedTodo {
  doc: IrisDoc;
  todo: DocTodo;
  workspaceName: string;
  workspacePath: string;
}

/**
 * All UNCHECKED tasks across ACTIVE issues — the todo panel's read side.
 * Activity depends on document status in every workspace.
 */
export function collectTodos(root: IrisWorkspace, workspacePath: string | null): CollectedTodo[] {
  const out: CollectedTodo[] = [];
  for (const item of collectDocs(root, 'issue', workspacePath)) {
    if (!isActiveIssue(item.doc)) continue;
    for (const todo of item.doc.todos) {
      if (todo.checked) continue;
      out.push({
        doc: item.doc,
        todo,
        workspaceName: item.workspaceName,
        workspacePath: item.workspacePath,
      });
    }
  }
  return out;
}

/** Date for list display: filename YYYY-MM-DD prefix, else mtime. */
export function docDate(doc: IrisDoc): string {
  const m = /^(\d{4}-\d{2}-\d{2})-/.exec(doc.name);
  if (m) return m[1]!;
  if (doc.mtimeMs > 0) {
    const d = new Date(doc.mtimeMs);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return '';
}
