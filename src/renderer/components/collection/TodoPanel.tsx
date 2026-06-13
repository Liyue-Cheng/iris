/**
 * The todo panel — every unchecked GFM task across ACTIVE issues, grouped
 * by source issue. The list is a pure projection of the scan (todos ride
 * IrisDoc, kept live by the fs-interrupt rescan loop); checking a box is a
 * single-line body surgery (todo-actions) and the row disappears when the
 * watcher echoes the write back through the next scan.
 */
import { useState } from 'react';
import { Loader2, Square } from 'lucide-react';
import type { IrisWorkspace } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { collectTodos, docDate, type CollectedTodo } from '@renderer/lib/collect-docs';
import { docDisplayTitle } from '@renderer/lib/doc-utils';
import { checkTodo } from '@renderer/lib/todo-actions';
import { projectStore } from '@renderer/stores/project-store';

interface TodoGroup {
  docPath: string;
  title: string;
  workspaceName: string;
  date: string;
  items: CollectedTodo[];
}

function groupByDoc(todos: CollectedTodo[]): TodoGroup[] {
  const byPath = new Map<string, TodoGroup>();
  for (const item of todos) {
    let g = byPath.get(item.doc.path);
    if (!g) {
      g = {
        docPath: item.doc.path,
        title: docDisplayTitle(item.doc),
        workspaceName: item.workspaceName,
        date: docDate(item.doc),
        items: [],
      };
      byPath.set(item.doc.path, g);
    }
    g.items.push(item);
  }
  const groups = [...byPath.values()];
  groups.sort((a, b) => b.date.localeCompare(a.date) || a.docPath.localeCompare(b.docPath));
  for (const g of groups) g.items.sort((a, b) => a.todo.line - b.todo.line);
  return groups;
}

export function TodoPanel({
  root,
  workspacePath,
}: {
  root: IrisWorkspace;
  workspacePath: string | null;
}): JSX.Element {
  // Lines with a write in flight: render checked+spinner until the rescan
  // removes the row (or the surgery refuses and the key is dropped).
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const todos = collectTodos(root, workspacePath);
  const groups = groupByDoc(todos);

  const onCheck = async (item: CollectedTodo): Promise<void> => {
    const key = `${item.doc.path}#${item.todo.line}`;
    setPending((p) => new Set(p).add(key));
    let ok = false;
    try {
      ok = await checkTodo(item.doc.path, item.todo);
    } finally {
      if (!ok) {
        setPending((p) => {
          const next = new Set(p);
          next.delete(key);
          return next;
        });
      }
      // On success the key stays pending; the row (and the stale key with
      // it) leaves the projection at the next scan.
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card/30 px-4">
        <h2 className="text-sm font-semibold">
          待办
          {workspacePath && (
            <button
              type="button"
              title="清除工作区过滤"
              className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground hover:bg-accent"
              onClick={() => projectStore.openTodos(null)}
            >
              {workspacePath} ✕
            </button>
          )}
        </h2>
        <span className="text-[11px] text-muted-foreground">{todos.length}</span>
        <span className="ml-auto text-[11px] text-muted-foreground/60">
          来自活动 issue 的未勾选任务项
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {groups.map((g) => (
          <div key={g.docPath} className="mb-1">
            <button
              type="button"
              onClick={() => void projectStore.selectDoc(g.docPath)}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-muted/60"
              title={g.docPath}
            >
              <span className="truncate text-[13px] font-semibold">{g.title}</span>
              <span className="shrink-0 rounded-sm bg-muted px-1 py-px text-[10px] text-muted-foreground">
                {g.items.length}
              </span>
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {g.workspaceName}
              </span>
              <span className="w-24 shrink-0 text-right text-[11px] text-muted-foreground">
                {g.date}
              </span>
            </button>
            {g.items.map((item) => {
              const key = `${item.doc.path}#${item.todo.line}`;
              const isPending = pending.has(key);
              return (
                <div
                  key={key}
                  className={cn(
                    'group flex w-full items-start gap-2 py-1.5 pl-7 pr-4 text-left text-sm hover:bg-muted/40',
                    isPending && 'opacity-60',
                  )}
                >
                  <button
                    type="button"
                    title="勾选（写回源文档）"
                    disabled={isPending}
                    onClick={() => void onCheck(item)}
                    className="mt-0.5 shrink-0 text-muted-foreground hover:text-[var(--rp-pine)]"
                  >
                    {isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Square className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void projectStore.selectDoc(item.doc.path)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className={cn('break-words', isPending && 'line-through')}>
                      {item.todo.text}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        {groups.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            没有未完成的待办——活动 issue 正文里的 <code>- [ ]</code> 任务项会出现在这里
          </div>
        )}
      </div>
    </div>
  );
}
