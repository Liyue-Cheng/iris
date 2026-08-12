/**
 * The lens tree (software-definition.md §5 左栏): workspaces as group
 * levels, docs classified by type inside each. The issue section shows
 * ACTIVE issues only; reports hide `Backlog`; archived workspaces (inside
 * report/) render grayed as one frozen block.
 *
 * Root and sub-workspaces are symmetric (子工作区平权): both render flat with
 * NO indentation — depth reads from the chevron + bold header, not a rail —
 * and both carry the collapse gesture. The header's chevron folds only the
 * document type sections; the hub's sessions and nested child workspaces stay
 * visible. Clicking the header NAME (not the chevron) stages that hub's
 * terminal full-width (root drops the README), so every workspace header
 * doubles as a terminal hub.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  selectedSessionIdForAnchor,
  sessionAnchorKey,
  useSessions,
  workspaceAnchorKey,
} from '@renderer/stores/session-store';
import type { DocType, IrisDoc, IrisWorkspace } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { docDisplayTitle, isActiveIssue } from '@renderer/lib/doc-utils';
import { useLensPrefs, type LensSort } from '@renderer/stores/lens-prefs';
import { useSettings } from '@renderer/stores/settings-store';
import { closeSession, openWorkspaceSession } from '@renderer/lib/session-actions';
import { isActiveReportStatus } from '@shared/document-status';
import { StatusBadge } from '@renderer/components/ui/status-badge';
import { SessionDot } from '@renderer/components/ui/session-dot';
import { LauncherMenuItems } from '@renderer/components/layout/RightPane';
import {
  DropdownMenu,
  DropdownMenuContent,
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
import { compareDisplayText } from '@renderer/lib/locale';

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
    out.sort((a, b) => compareDisplayText(docDisplayTitle(a), docDisplayTitle(b)));
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
  const { view } = useProject();
  const selected = view.kind === 'doc' && view.path === doc.path;

  return (
    <DocContextMenu docPath={doc.path} docName={doc.name}>
      <button
        type="button"
        onClick={() => void projectStore.selectDoc(doc.path)}
        draggable
        onDragStart={(e) => setDocDragData(e.dataTransfer, doc.path)}
        className={cn(
          'group flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm leading-tight',
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const { sort, filter } = useLensPrefs();
  const { sessions } = useSessions();
  const { label, icon: Icon } = TYPE_META[type];

  // Lens filters: issues show active ones plus any inactive issue that still
  // anchors a terminal. Exited sessions count too: their scrollback remains
  // available until the user explicitly closes the session. Reports use the
  // same shared activity semantics. Archived
  // sections freeze whole and show everything. Then sort + text filter apply.
  const lensDocs =
    type === 'issue' && !archived
      ? docs.filter(
          (doc) =>
            isActiveIssue(doc) || sessions.some((session) => session.docPath === doc.path),
        )
      : type === 'report' && !archived
        ? docs.filter((d) => isActiveReportStatus(d.status))
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
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          title={open ? t('layout.collapse') : t('layout.expand')}
          onClick={() => setOpen(!open)}
          className="shrink-0 px-1 py-0.5 text-muted-foreground hover:text-foreground"
        >
          {sectionOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          data-collection-entry-type={type}
          data-collection-entry-workspace={workspacePath}
          title={t('layout.openCollection', { type: label })}
          onClick={() =>
            projectStore.openCollection(type, workspacePath === '.iris' ? null : workspacePath)
          }
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
          <span className="ml-1 font-normal text-muted-foreground/60">{visibleDocs.length}</span>
        </button>
        {!archived && (
          <button
            type="button"
            title={t('layout.newDocument', { type: label })}
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
              {type === 'issue' && docs.length > 0 ? t('layout.noActiveIssues') : t('common.empty')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The project-root workspace's anchor path (the root hub). */
const ROOT_WS_PATH = '.iris';

/** Stage a workspace hub's terminal full-width (root → selectRoot). */
function selectHub(workspacePath: string): void {
  if (workspacePath === ROOT_WS_PATH) void projectStore.selectRoot();
  else void projectStore.selectWorkspace(workspacePath);
}

/**
 * The new-session +, beside a workspace header (主页重设计 + 子工作区平权):
 * spawns a hub session (docPath null, NO FOCUS_DOC) grouped under this
 * workspace. Both the root and every sub-workspace get one — terminal parity.
 */
function NewWorkspaceSessionButton({
  workspacePath,
  label,
}: {
  workspacePath: string;
  label: string;
}): JSX.Element {
  const { t } = useTranslation();
  const settings = useSettings();
  const agents = settings?.agents ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t('layout.newSession')}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground/0 hover:!text-foreground group-hover/hub:text-muted-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel className="max-w-52 truncate">{t('layout.workspaceFallback', { name: label })}</DropdownMenuLabel>
        <LauncherMenuItems
          agents={agents}
          onSelect={(agentId) => void openWorkspaceSession(workspacePath, agentId)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Hub session rows, listed directly under a workspace header (主页重设计 +
 * 平权): the left pane is the attention-scheduling panel, so a workspace's
 * terminals live here (above status/issue/…) with no section header. A click
 * stages that session in the full-width terminal. Empty → nothing.
 */
function WorkspaceSessionList({ workspacePath }: { workspacePath: string }): JSX.Element | null {
  const { t } = useTranslation();
  const { sessions } = useSessions();
  const { view } = useProject();
  const hubKey = workspaceAnchorKey(workspacePath);
  const hubSessions = sessions.filter((s) => sessionAnchorKey(s) === hubKey);
  if (hubSessions.length === 0) return null;
  const isThisHubView =
    workspacePath === ROOT_WS_PATH
      ? view.kind === 'root'
      : view.kind === 'workspace' && view.path === workspacePath;

  return (
    <div>
      {hubSessions.map((s) => {
        const active = isThisHubView && selectedSessionIdForAnchor(hubKey) === s.id;
        const label = s.terminalTitle ?? s.displayName;
        return (
          <ContextMenu key={s.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={() => void projectStore.activateSession(s.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm leading-tight',
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
                {t('layout.closeSession')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}

/**
 * A workspace section — root and sub are now symmetric (子工作区平权). The
 * header is `[chevron | name | +]`:
 *   - chevron folds ONLY the document type sections; the hub's sessions and
 *     any nested child workspaces stay visible. This is what lets you collapse
 *     the root's docs while keeping the sub-workspaces (its children) in view.
 *   - the name stages this hub's terminal full-width (selectRoot/selectWorkspace).
 *   - + spawns a hub session (no FOCUS_DOC).
 * No indentation (平铺) — depth is read from the chevron + bold header, not a
 * rail. Only one selection shadow at a time: a staged hub session carries the
 * highlight and the header stays plain; the header highlights only when this
 * hub view shows no session (the launch pad). Archived workspaces freeze: no
 * +, no hub selection, sessions hidden — just grayed, collapsible docs.
 */
function WorkspaceSection({
  ws,
  depth,
  parentArchived,
}: {
  ws: IrisWorkspace;
  depth: number;
  parentArchived: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const [sectionsOpen, setSectionsOpen] = useState(true);
  const { view } = useProject();
  const { sessions } = useSessions();
  const archived = ws.archived || parentArchived;
  const isRoot = depth === 0;
  const workspacePath = isRoot ? ROOT_WS_PATH : ws.path;
  const byType = (t: DocType): IrisDoc[] => ws.docs.filter((d) => d.type === t);

  const isThisHubView = isRoot
    ? view.kind === 'root'
    : view.kind === 'workspace' && view.path === ws.path;
  const hubKey = workspaceAnchorKey(workspacePath);
  const hubSessionStaged =
    isThisHubView &&
    sessions.some(
      (session) =>
        sessionAnchorKey(session) === hubKey &&
        session.id === selectedSessionIdForAnchor(hubKey),
    );
  const headerSelected = isThisHubView && !hubSessionStaged;

  return (
    <div>
      <div
        className={cn(
          'group/hub flex items-center gap-1 rounded-sm pr-1',
          !archived && headerSelected
            ? 'bg-accent text-accent-foreground'
            : cn('hover:bg-muted', archived ? 'text-muted-foreground/70' : 'text-foreground'),
        )}
      >
        <button
          type="button"
          title={sectionsOpen ? t('layout.collapseDocuments') : t('layout.expandDocuments')}
          onClick={() => setSectionsOpen(!sectionsOpen)}
          className="shrink-0 px-1 py-1.5 text-muted-foreground hover:text-foreground"
        >
          {sectionsOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        {archived ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-[13px] font-semibold">
            <span className="truncate">{ws.name}</span>
            <span className="ml-1 flex items-center gap-0.5 rounded-sm bg-muted px-1 py-px text-[11px] font-normal text-muted-foreground">
              <Archive className="h-2.5 w-2.5" />
              {t('layout.archived')}
            </span>
          </span>
        ) : (
          <>
            <button
              type="button"
              title={isRoot ? t('layout.rootHubHint') : t('layout.workspaceHubHint')}
              onClick={() => selectHub(workspacePath)}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-[13px] font-semibold"
            >
              {isRoot && <FolderRoot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              <span className="truncate">{ws.name}</span>
            </button>
            <NewWorkspaceSessionButton workspacePath={workspacePath} label={isRoot ? t('layout.projectRoot') : ws.name} />
          </>
        )}
      </div>
      <div className={cn('space-y-2 pt-1', archived && 'opacity-75')}>
        {!archived && <WorkspaceSessionList workspacePath={workspacePath} />}
        {sectionsOpen &&
          TYPE_ORDER.map((t) => (
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
