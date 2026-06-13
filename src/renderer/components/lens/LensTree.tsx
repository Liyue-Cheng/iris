/**
 * The lens tree (software-definition.md §5 左栏): workspaces as group
 * levels, docs classified by type inside each. The issue section shows
 * ACTIVE issues only; reports hide `Backlog`; archived workspaces (inside
 * report/) render grayed as one frozen block.
 *
 * The ROOT node is special (round-3 E-4): not a collapse toggle — clicking
 * it shows the project README in the middle pane and the project-root
 * terminals on the right. Nested workspaces keep the collapse gesture.
 */
import { useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FileWarning,
  FolderRoot,
  Gauge,
  NotebookPen,
  Plus,
  ScrollText,
} from 'lucide-react';
import { openCreateDialog } from '@renderer/components/doc/CreateDocDialog';
import { DocContextMenu } from '@renderer/components/doc/DocContextMenu';
import { aggregateDocState, useSessions } from '@renderer/stores/session-store';
import type { DocType, IrisDoc, IrisWorkspace } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { docDisplayTitle, isActiveIssue } from '@renderer/lib/doc-utils';
import { StatusBadge } from '@renderer/components/ui/status-badge';
import { setDocDragData } from '@renderer/lib/doc-drag';
import { projectStore, useProject } from '@renderer/stores/project-store';

const TYPE_ORDER: DocType[] = ['status', 'issue', 'report', 'misc'];

const TYPE_META: Record<DocType, { label: string; icon: typeof Gauge }> = {
  status: { label: 'status', icon: Gauge },
  issue: { label: 'issue', icon: CircleDot },
  report: { label: 'report', icon: ScrollText },
  misc: { label: 'misc', icon: NotebookPen },
};

/**
 * Session status dot — the left pane is the attention-scheduling panel
 * (软件定义书 §5): ● a session is working / ◐ idle, likely waiting for you /
 * ○ exited only / blank when the doc has no sessions.
 */
function StatusDot({ docPath }: { docPath: string }): JSX.Element {
  const { sessions } = useSessions();
  const agg = aggregateDocState(sessions, docPath);
  if (agg === 'active') {
    return <span className="w-3 shrink-0 text-center text-[10px] text-[var(--rp-foam)]">●</span>;
  }
  if (agg === 'idle') {
    return <span className="w-3 shrink-0 text-center text-[10px] text-[var(--rp-gold)]">◐</span>;
  }
  if (agg === 'exited') {
    return <span className="w-3 shrink-0 text-center text-[10px] text-muted-foreground/60">○</span>;
  }
  return <span className="w-3 shrink-0" />;
}

function DocRow({ doc, archived }: { doc: IrisDoc; archived: boolean }): JSX.Element {
  const { selectedPath } = useProject();
  const selected = selectedPath === doc.path;

  return (
    <DocContextMenu docPath={doc.path} docName={doc.name}>
      <button
        type="button"
        onClick={() => void projectStore.selectDoc(doc.path)}
        draggable
        onDragStart={(e) => setDocDragData(e.dataTransfer, doc.path)}
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-sm leading-tight',
          selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
          archived && 'opacity-60',
        )}
        title={doc.path}
      >
        <StatusDot docPath={doc.path} />
        <span className="truncate">{docDisplayTitle(doc)}</span>
        {doc.frontmatterBroken && (
          <FileWarning className="ml-auto h-3.5 w-3.5 shrink-0 text-destructive/80" />
        )}
        {doc.type === 'issue' && doc.status && !doc.frontmatterBroken && (
          <StatusBadge value={doc.status} size="sm" className="ml-auto shrink-0" />
        )}
      </button>
    </DocContextMenu>
  );
}

function TypeSection({
  type,
  docs,
  archived,
  workspacePath,
}: {
  type: DocType;
  docs: IrisDoc[];
  archived: boolean;
  workspacePath: string;
}): JSX.Element | null {
  const [open, setOpen] = useState(true);
  const { label, icon: Icon } = TYPE_META[type];

  // Lens filters: issues show active only; reports hide `Backlog` (literal
  // match — the two-state report machine, C 条). Archived sections freeze
  // whole and show everything.
  const visibleDocs =
    type === 'issue' && !archived
      ? docs.filter(isActiveIssue)
      : type === 'report' && !archived
        ? docs.filter((d) => d.status !== 'Backlog')
        : docs;
  // Archived workspaces are frozen: hide empty sections AND the + button.
  if (docs.length === 0 && archived) return null;

  return (
    <div className="group/section">
      <div className="flex items-center pr-1">
        <button
          type="button"
          title={open ? '折叠' : '展开'}
          onClick={() => setOpen(!open)}
          className="px-2 py-0.5 text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          title={`打开 ${label} 集合视图`}
          onClick={() =>
            projectStore.openCollection(type, workspacePath === '.iris' ? null : workspacePath)
          }
          className="flex min-w-0 flex-1 items-center gap-1 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
          <span className="ml-1 font-normal text-muted-foreground/60">{visibleDocs.length}</span>
        </button>
        {!archived && (
          <button
            type="button"
            title={`新建 ${label} 文档`}
            onClick={() => openCreateDialog({ workspacePath, type })}
            className="rounded-sm p-0.5 text-muted-foreground/0 hover:bg-muted hover:!text-foreground group-hover/section:text-muted-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div className="pb-1">
          {visibleDocs.map((d) => (
            <DocRow key={d.path} doc={d} archived={archived} />
          ))}
          {visibleDocs.length === 0 && (
            <div className="px-7 py-0.5 text-xs text-muted-foreground/50">
              {type === 'issue' && docs.length > 0 ? '无活动 issue' : '空'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceSection({
  ws,
  depth,
  parentArchived,
}: {
  ws: IrisWorkspace;
  depth: number;
  parentArchived: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const { view } = useProject();
  const archived = ws.archived || parentArchived;
  const isRoot = depth === 0;
  const byType = (t: DocType): IrisDoc[] => ws.docs.filter((d) => d.type === t);

  return (
    <div className={cn(depth > 0 && 'ml-2 border-l border-border/60 pl-1')}>
      {isRoot ? (
        // Root node: a selection gesture, not a collapse toggle (E-4).
        <button
          type="button"
          title="项目根 — 中栏显示 README，右栏显示项目根终端"
          onClick={() => void projectStore.selectRoot()}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-[13px] font-semibold',
            view.kind === 'root'
              ? 'bg-accent text-accent-foreground'
              : 'text-foreground hover:bg-muted',
          )}
        >
          <FolderRoot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{ws.name}</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={cn(
            'flex w-full items-center gap-1 px-1 py-1 text-[13px] font-semibold',
            archived ? 'text-muted-foreground/70' : 'text-foreground',
          )}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="truncate">{ws.name}</span>
          {archived && (
            <span className="ml-1 flex items-center gap-0.5 rounded-sm bg-muted px-1 py-px text-[11px] font-normal text-muted-foreground">
              <Archive className="h-2.5 w-2.5" />
              已归档
            </span>
          )}
        </button>
      )}
      {(isRoot || open) && (
        <div className={cn(archived && 'opacity-75')}>
          {TYPE_ORDER.map((t) => (
            <TypeSection
              key={t}
              type={t}
              docs={byType(t)}
              archived={archived}
              workspacePath={ws.path}
            />
          ))}
          {ws.children.map((c) => (
            <WorkspaceSection key={c.path} ws={c} depth={depth + 1} parentArchived={archived} />
          ))}
        </div>
      )}
    </div>
  );
}

export function LensTree({ root }: { root: IrisWorkspace }): JSX.Element {
  return (
    <div className="px-1 py-1">
      <WorkspaceSection ws={root} depth={0} parentArchived={false} />
    </div>
  );
}
