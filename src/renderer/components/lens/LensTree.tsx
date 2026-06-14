/**
 * The lens tree (software-definition.md §5 左栏): workspaces as group
 * levels, docs classified by type inside each. The issue section shows
 * ACTIVE issues only; reports hide `Backlog`; archived workspaces (inside
 * report/) render grayed as one frozen block.
 *
 * The ROOT node is special (round-3 E-4, 主页重设计): not a collapse toggle —
 * clicking it drops the README and gives the terminal the full width. Its
 * project-root sessions are listed right under it (above the type sections),
 * so the root node doubles as the terminal hub. Nested workspaces keep the
 * collapse gesture.
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
import {
  aggregateDocState,
  sessionStore,
  useSessions,
} from '@renderer/stores/session-store';
import type { DocType, IrisDoc, IrisWorkspace } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { docDisplayTitle, isActiveIssue } from '@renderer/lib/doc-utils';
import { useLensPrefs, type LensSort } from '@renderer/stores/lens-prefs';
import { useSettings } from '@renderer/stores/settings-store';
import { closeSession, openSession } from '@renderer/lib/session-actions';
import { StatusBadge } from '@renderer/components/ui/status-badge';
import { SessionDot } from '@renderer/components/ui/session-dot';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
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
  return <SessionDot state={aggregateDocState(sessions, docPath)} />;
}

/** Order docs inside a type section per the left-pane sort preference. */
function sortDocs(docs: IrisDoc[], sort: LensSort): IrisDoc[] {
  const out = [...docs];
  if (sort === 'mtime') {
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } else {
    out.sort((a, b) => docDisplayTitle(a).localeCompare(docDisplayTitle(b), 'zh'));
  }
  return out;
}

/** Text filter over file name + display title (case-insensitive). */
function matchesFilter(doc: IrisDoc, filter: string): boolean {
  if (filter === '') return true;
  return (
    doc.name.toLowerCase().includes(filter) ||
    docDisplayTitle(doc).toLowerCase().includes(filter)
  );
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
  const { sort, filter } = useLensPrefs();
  const { label, icon: Icon } = TYPE_META[type];

  // Lens filters: issues show active only; reports hide `Backlog` (literal
  // match — the two-state report machine, C 条). Archived sections freeze
  // whole and show everything. Then the user's sort + text filter apply.
  const lensDocs =
    type === 'issue' && !archived
      ? docs.filter(isActiveIssue)
      : type === 'report' && !archived
        ? docs.filter((d) => d.status !== 'Backlog')
        : docs;
  const visibleDocs = sortDocs(
    lensDocs.filter((d) => matchesFilter(d, filter)),
    sort,
  );
  // Archived workspaces are frozen: hide empty sections AND the + button.
  if (docs.length === 0 && archived) return null;
  // While filtering, drop sections with no match and force the rest open.
  if (filter !== '' && visibleDocs.length === 0) return null;
  const sectionOpen = filter !== '' ? true : open;

  return (
    <div className="group/section">
      <div className="flex items-center pr-1">
        <button
          type="button"
          title={open ? '折叠' : '展开'}
          onClick={() => setOpen(!open)}
          className="px-2 py-0.5 text-muted-foreground hover:text-foreground"
        >
          {sectionOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
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
      {sectionOpen && (
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

/**
 * The new-root-session +, sitting beside the root node's title (主页重设计):
 * spawns a project-root session (docPath null, no FOCUS_DOC) with the chosen
 * agent. The root sessions themselves list directly below the root node.
 */
function NewRootSessionButton(): JSX.Element {
  const settings = useSettings();
  const agents = settings?.agents ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="新建项目根会话"
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground/0 hover:!text-foreground group-hover/root:text-muted-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>项目根（无聚焦兜底）</DropdownMenuLabel>
        {agents.map((a) => (
          <DropdownMenuItem key={a.id} onClick={() => void openSession(null, a.id)}>
            用 {a.label} 打开
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The root node row (主页重设计): the project-root selection gesture plus the
 * new-session +. Only one shadow at a time — when a root session row is the
 * active terminal, IT carries the highlight and the iris node stays plain; the
 * node highlights only when the root view shows no session (the launch pad).
 */
function RootNodeRow({ name }: { name: string }): JSX.Element {
  const { view } = useProject();
  const { sessions, activeSessionId } = useSessions();
  const rootSessionActive =
    view.kind === 'root' &&
    sessions.some((s) => s.docPath === null && s.id === activeSessionId);
  const selected = view.kind === 'root' && !rootSessionActive;

  return (
    <div
      className={cn(
        'group/root flex items-center gap-1 rounded-sm pr-1',
        selected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted',
      )}
    >
      <button
        type="button"
        title="项目根 — 终端独占全屏；根会话列在下方"
        onClick={() => void projectStore.selectRoot()}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-[13px] font-semibold"
      >
        <FolderRoot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{name}</span>
      </button>
      <NewRootSessionButton />
    </div>
  );
}

/**
 * Project-root session rows, listed directly under the root node (主页重设计):
 * the left pane is the attention-scheduling panel, so the root terminals live
 * here (above status/issue/…) with no section header — just the rows. A click
 * stages that session in the full-width terminal. Empty → nothing.
 */
function RootSessionList(): JSX.Element | null {
  const { sessions, activeSessionId } = useSessions();
  const { view } = useProject();
  const rootSessions = sessions.filter((s) => s.docPath === null);
  if (rootSessions.length === 0) return null;
  const isRootView = view.kind === 'root';

  return (
    <div>
      {rootSessions.map((s) => {
        const active = isRootView && activeSessionId === s.id;
        const label = s.terminalTitle ?? s.displayName;
        return (
          <ContextMenu key={s.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={async () => {
                  await projectStore.selectRoot();
                  sessionStore.select(s.id);
                }}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-sm leading-tight',
                  active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
                title={label}
              >
                <SessionDot state={s.state} />
                <span className="truncate">{label}</span>
                {s.state === 'exited' && (
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/60">
                    exit {s.exitCode}
                  </span>
                )}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => void closeSession(s.id)}
              >
                关闭会话
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
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
  const archived = ws.archived || parentArchived;
  const isRoot = depth === 0;
  const byType = (t: DocType): IrisDoc[] => ws.docs.filter((d) => d.type === t);

  return (
    <div className={cn(depth > 0 && 'ml-2 border-l border-subtle pl-1')}>
      {isRoot ? (
        <RootNodeRow name={ws.name} />
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
        <div className={cn('space-y-2 pt-1', archived && 'opacity-75')}>
          {isRoot && <RootSessionList />}
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
