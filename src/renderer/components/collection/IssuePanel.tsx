/**
 * The issue panel — Linear-style management list (软件定义书 §5 中栏:
 * issue 是重头戏，在这里处理所有 issue). List first; board view is a
 * post-v1 direction.
 *
 * Filters: 活动中 (default — mirrors the left lens) / 已解决 / 全部.
 * Archived-workspace issues are frozen history: excluded from 活动中,
 * grayed elsewhere. Inline status edit covers the soft state machine;
 * free-form values still belong to the typed header.
 */
import { useState } from 'react';
import { Archive, ChevronDown, FileWarning, Plus } from 'lucide-react';
import type { IrisWorkspace } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { collectDocs, docDate, type CollectedDoc } from '@renderer/lib/collect-docs';
import {
  docDisplayTitle,
  docPriority,
  isActiveIssue,
  priorityRank,
  SOFT_PRIORITIES,
} from '@renderer/lib/doc-utils';
import { setDocDragData } from '@renderer/lib/doc-drag';
import { setDocField, setDocStatus } from '@renderer/lib/issue-actions';
import { LabelChip } from '@renderer/components/ui/label-chip';
import { projectStore } from '@renderer/stores/project-store';
import { openCreateDialog } from '@renderer/components/doc/CreateDocDialog';
import { DocContextMenu } from '@renderer/components/doc/DocContextMenu';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';

type Filter = 'active' | 'resolved' | 'all';

const FILTER_LABEL: Record<Filter, string> = {
  active: '活动中',
  resolved: '已解决',
  all: '全部',
};

const SOFT_STATUSES = ['todo', 'in_progress', 'blocked', 'done'];

const STATUS_CLS: Record<string, string> = {
  todo: 'bg-muted text-muted-foreground',
  in_progress: 'bg-[var(--rp-foam)]/20 text-[var(--rp-foam)]',
  blocked: 'bg-[var(--rp-love)]/20 text-[var(--rp-love)]',
  done: 'bg-[var(--rp-pine)]/20 text-[var(--rp-pine)]',
};

const PRIORITY_CLS: Record<string, string> = {
  urgent: 'bg-[var(--rp-love)]/20 text-[var(--rp-love)]',
  high: 'bg-[var(--rp-gold)]/20 text-[var(--rp-gold)]',
  medium: 'bg-[var(--rp-foam)]/20 text-[var(--rp-foam)]',
  low: 'bg-muted text-muted-foreground',
};

function PriorityCell({ item }: { item: CollectedDoc }): JSX.Element {
  const { doc, archived } = item;
  const value = docPriority(doc);
  const editable = !archived && !doc.frontmatterBroken;
  const badge = (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px]',
        value === null
          ? 'text-muted-foreground/50'
          : (PRIORITY_CLS[value.toLowerCase()] ?? 'bg-[var(--rp-gold)]/20 text-[var(--rp-gold)]'),
      )}
    >
      {value ?? '—'}
      {editable && <ChevronDown className="h-2.5 w-2.5 opacity-60" />}
    </span>
  );
  if (!editable) return badge;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()}>
          {badge}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {SOFT_PRIORITIES.map((p) => (
          <DropdownMenuItem
            key={p}
            onClick={(e) => {
              e.stopPropagation();
              void setDocField(item.doc.path, 'priority', p);
            }}
          >
            <span className={cn('rounded px-1.5 py-0.5 text-[11px]', PRIORITY_CLS[p])}>{p}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusCell({ item }: { item: CollectedDoc }): JSX.Element {
  const { doc, archived } = item;
  const value = doc.status ?? '—';
  const editable = !archived && !doc.frontmatterBroken;
  const badge = (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px]',
        STATUS_CLS[value.toLowerCase()] ?? 'bg-[var(--rp-gold)]/20 text-[var(--rp-gold)]',
      )}
    >
      {value}
      {editable && <ChevronDown className="h-2.5 w-2.5 opacity-60" />}
    </span>
  );
  if (!editable) return badge;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()}>
          {badge}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {SOFT_STATUSES.map((s) => (
          <DropdownMenuItem
            key={s}
            onClick={(e) => {
              e.stopPropagation();
              void setDocStatus(item.doc.path, s);
            }}
          >
            <span className={cn('rounded px-1.5 py-0.5 text-[11px]', STATUS_CLS[s])}>{s}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function IssuePanel({
  root,
  workspacePath,
}: {
  root: IrisWorkspace;
  workspacePath: string | null;
}): JSX.Element {
  const [filter, setFilter] = useState<Filter>('active');
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const all = collectDocs(root, 'issue', workspacePath).filter(
    (item) => labelFilter === null || item.doc.labels.includes(labelFilter),
  );

  const rows = all.filter((item) => {
    if (filter === 'active') return !item.archived && isActiveIssue(item.doc);
    if (filter === 'resolved') return !isActiveIssue(item.doc);
    return true;
  });
  rows.sort(
    (a, b) =>
      priorityRank(docPriority(a.doc)) - priorityRank(docPriority(b.doc)) ||
      docDate(b.doc).localeCompare(docDate(a.doc)) ||
      a.doc.path.localeCompare(b.doc.path),
  );

  const counts: Record<Filter, number> = {
    active: all.filter((i) => !i.archived && isActiveIssue(i.doc)).length,
    resolved: all.filter((i) => !isActiveIssue(i.doc)).length,
    all: all.length,
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b bg-card/30 px-4 py-2">
        <h2 className="text-sm font-semibold">
          Issue
          {workspacePath && (
            <button
              type="button"
              title="清除工作区过滤"
              className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground hover:bg-accent"
              onClick={() => projectStore.openCollection('issue', null)}
            >
              {workspacePath} ✕
            </button>
          )}
          {labelFilter && (
            <button
              type="button"
              title="清除标签过滤"
              className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground hover:bg-accent"
              onClick={() => setLabelFilter(null)}
            >
              标签: {labelFilter} ✕
            </button>
          )}
        </h2>
        <div className="ml-2 flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
          {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px]',
                filter === f ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {FILTER_LABEL[f]}
              <span className="ml-1 text-muted-foreground/60">{counts[f]}</span>
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto h-7"
          onClick={() =>
            openCreateDialog({ workspacePath: workspacePath ?? '.iris', type: 'issue' })
          }
        >
          <Plus /> 新建 issue
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 bg-card text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-1.5 font-medium">标题</th>
              <th className="w-24 px-2 py-1.5 font-medium">优先级</th>
              <th className="w-32 px-2 py-1.5 font-medium">状态</th>
              <th className="w-44 px-2 py-1.5 font-medium">标签</th>
              <th className="w-36 px-2 py-1.5 font-medium">工作区</th>
              <th className="w-28 px-2 py-1.5 font-medium">日期</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <DocContextMenu key={item.doc.path} docPath={item.doc.path} docName={item.doc.name}>
                <tr
                  onClick={() => void projectStore.selectDoc(item.doc.path)}
                  draggable
                  onDragStart={(e) => setDocDragData(e.dataTransfer, item.doc.path)}
                  className={cn(
                    'cursor-pointer border-b border-border/40 hover:bg-muted/60',
                    item.archived && 'opacity-50',
                  )}
                  title={item.doc.path}
                >
                  <td className="px-4 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate">{docDisplayTitle(item.doc)}</span>
                      {item.doc.frontmatterBroken && (
                        <FileWarning className="h-3.5 w-3.5 shrink-0 text-destructive/80" />
                      )}
                      {item.archived && (
                        <Archive className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                      )}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <PriorityCell item={item} />
                  </td>
                  <td className="px-2 py-1.5">
                    <StatusCell item={item} />
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="flex flex-wrap gap-1">
                      {item.doc.labels.map((l) => (
                        <LabelChip
                          key={l}
                          label={l}
                          onClick={() => setLabelFilter(labelFilter === l ? null : l)}
                        />
                      ))}
                    </span>
                  </td>
                  <td className="truncate px-2 py-1.5 text-muted-foreground">{item.workspaceName}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{docDate(item.doc)}</td>
                </tr>
              </DocContextMenu>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-xs text-muted-foreground">
                  这个过滤下没有 issue
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
