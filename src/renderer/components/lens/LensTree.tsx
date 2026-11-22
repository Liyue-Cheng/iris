/**
 * The lens tree (software-definition.md §5 左栏): workspaces as group
 * levels, docs classified by type inside each. The issue section shows
 * ACTIVE issues only; reports hide `Backlog` in every workspace.
 *
 * Root and sub-workspaces are symmetric (子工作区平权): both render flat with
 * NO indentation — depth reads from the chevron + bold header, not a rail —
 * and both carry the collapse gesture. The header's chevron folds only the
 * document type sections; the hub's sessions and nested child workspaces stay
 * visible. Clicking the header NAME (not the chevron) stages that hub's
 * terminal full-width (root drops the README), so every workspace header
 * doubles as a terminal hub.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleDot,
  Copy,
  ExternalLink,
  FilePlus,
  FileWarning,
  FolderOpen,
  FolderPlus,
  FolderRoot,
  Gauge,
  ListChecks,
  NotebookPen,
  Plus,
  ScrollText,
  SquareTerminal,
} from 'lucide-react';
import { openCreateDialog } from '@renderer/components/doc/CreateDocDialog';
import { DocContextMenu } from '@renderer/components/doc/DocContextMenu';
import { CreateWorkspaceDialog } from '@renderer/components/project/CreateWorkspaceDialog';
import { writeClipboardText } from '@renderer/lib/clipboard';
import { openProjectItem, revealProjectItem } from '@renderer/lib/shell-actions';
import {
  workspaceAnchorKey,
} from '@renderer/stores/session-store';
import type { DocType, IrisDoc, IrisWorkspace } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { docDisplayTitle, isActiveIssue, shouldShowLensStatusBadge } from '@renderer/lib/doc-utils';
import { useLensPrefs, type LensSort } from '@renderer/stores/lens-prefs';
import { useSettings } from '@renderer/stores/settings-store';
import { openWorkspaceSession } from '@renderer/lib/session-actions';
import { openIrisAgent } from '@renderer/lib/iris-agent-actions';
import { closeProjectedSession } from '@renderer/lib/session-projection-actions';
import { isActiveDocumentStatus } from '@shared/document-status';
import { StatusBadge } from '@renderer/components/ui/status-badge';
import { SessionDot } from '@renderer/components/ui/session-dot';
import { LauncherMenuItems } from '@renderer/components/layout/RightPane';
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
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { setDocDragData } from '@renderer/lib/doc-drag';
import { ExternalSection } from './ExternalSection';
import { projectStore, useProject } from '@renderer/stores/project-store';
import { compareDisplayText } from '@renderer/lib/locale';
import { sessionViewStore, useSelectedSessionView } from '@renderer/stores/session-view-store';
import {
  aggregateProjectionState,
  sessionProjectionAnchorKey,
  useSessionProjections,
} from '@renderer/lib/session-projection';
import {
  leftPanePrefs,
  leftPaneTypeKey,
  useLeftPanePrefs,
} from '@renderer/lib/left-pane-prefs';

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
  const projections = useSessionProjections();
  return <SessionDot state={aggregateProjectionState(projections, docPath)} />;
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

function DocRow({ doc }: { doc: IrisDoc }): JSX.Element {
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
        )}
        aria-label={doc.path}
      >
        <StatusDot docPath={doc.path} />
        <span className="truncate">{docDisplayTitle(doc)}</span>
        {doc.frontmatterBroken && (
          <FileWarning className="ml-auto h-3.5 w-3.5 shrink-0 text-destructive/80" />
        )}
        {doc.status && shouldShowLensStatusBadge(doc) && (
          <StatusBadge value={doc.status} size="sm" className="ml-auto shrink-0" />
        )}
      </button>
    </DocContextMenu>
  );
}

function TypeSection({
  type,
  docs,
  workspacePath,
}: {
  type: DocType;
  docs: IrisDoc[];
  workspacePath: string;
}): JSX.Element | null {
  const { t } = useTranslation();
  const { scope } = useProject();
  const prefs = useLeftPanePrefs(scope?.root ?? null);
  const open = prefs.types[leftPaneTypeKey(workspacePath, type)] ?? true;
  const { sort, filter } = useLensPrefs();
  const projections = useSessionProjections();
  const { label, icon: Icon } = TYPE_META[type];

  // Lens filters: issues show active ones plus any inactive issue that still
  // anchors a terminal. Exited sessions count too: their scrollback remains
  // available until the user explicitly closes the session. Reports use the
  // same shared activity semantics. Then sort + text filter apply.
  const lensDocs =
    type === 'issue'
      ? docs.filter(
          (doc) =>
            isActiveIssue(doc) ||
            projections.some((session) => session.anchor.kind === 'document' && session.anchor.path === doc.path),
        )
      : docs.filter((d) => isActiveDocumentStatus(d.status));
  const visibleDocs = sortDocs(
    lensDocs.filter((d) => matchesFilter(d, filter)),
    sort,
  );
  // While filtering, drop sections with no match and force the rest open.
  if (filter !== '' && visibleDocs.length === 0) return null;
  const sectionOpen = filter !== '' ? true : open;

  return (
    <div className="group/section">
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          aria-label={open ? t('layout.collapse') : t('layout.expand')}
          disabled={filter !== ''}
          onClick={() => {
            if (scope && filter === '') {
              leftPanePrefs.setTypeOpen(scope.root, workspacePath, type, !open);
            }
          }}
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
          aria-label={t('layout.openCollection', { type: label })}
          onClick={() =>
            projectStore.openCollection(type, workspacePath === '.iris' ? null : workspacePath)
          }
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
          <span className="ml-1 font-normal text-muted-foreground/60">{visibleDocs.length}</span>
        </button>
        <button
          type="button"
          aria-label={t('layout.newDocument', { type: label })}
          onClick={() => openCreateDialog({ workspacePath, type })}
          className="rounded-sm p-0.5 text-muted-foreground/0 hover:bg-muted hover:!text-foreground group-hover/section:text-muted-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {sectionOpen && (
        <div className="pb-1">
          {visibleDocs.map((d) => (
            <DocRow key={d.path} doc={d} />
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
 * When Iris Agent is enabled the same menu also offers an Agent session on the
 * workspace anchor, so the two session domains launch from identical places.
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
  const irisAgentEnabled = settings?.experimental.irisAgent ?? false;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('layout.newSession')}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground/0 hover:!text-foreground group-hover/hub:text-muted-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel className="max-w-52 truncate">{t('layout.workspaceFallback', { name: label })}</DropdownMenuLabel>
        {irisAgentEnabled && (
          <DropdownMenuItem
            onClick={() => void openIrisAgent({ kind: 'workspace', path: workspacePath })}
          >
            {t('layout.openWith', { agent: t('settings.irisAgent') })}
          </DropdownMenuItem>
        )}
        <LauncherMenuItems
          agents={agents}
          onSelect={(agentId) => void openWorkspaceSession(workspacePath, agentId)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Join a project-relative workspace path onto the absolute project root. */
function absoluteWorkspacePath(root: string, path: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${path.split('/').join(sep)}`;
}

/**
 * Right-click menu on a workspace header — root and sub-workspaces share it
 * (子工作区平权). It gathers the hub's create gestures (session, document,
 * child workspace), its views (todos, document fold), and the folder's file
 * operations. No delete: removing a workspace is not a lens-tree gesture.
 */
function WorkspaceContextMenu({
  workspacePath,
  label,
  isRoot,
  sectionsOpen,
  onToggleSections,
  onCreateChild,
  children,
}: {
  workspacePath: string;
  label: string;
  isRoot: boolean;
  sectionsOpen: boolean;
  onToggleSections: () => void;
  onCreateChild: (parentPath: string) => void;
  children: ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  const settings = useSettings();
  const { scope } = useProject();
  const agents = settings?.agents ?? [];
  const irisAgentEnabled = settings?.experimental.irisAgent ?? false;
  const hasLaunchers = irisAgentEnabled || agents.length > 0;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel className="truncate">{label}</ContextMenuLabel>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!hasLaunchers}>
            <SquareTerminal /> {t('layout.newSession')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-80 w-56 overflow-y-auto">
            {irisAgentEnabled && (
              <ContextMenuItem
                onClick={() => void openIrisAgent({ kind: 'workspace', path: workspacePath })}
              >
                {t('layout.openWith', { agent: t('settings.irisAgent') })}
              </ContextMenuItem>
            )}
            {agents.map((agent) => (
              <ContextMenuItem
                key={agent.id}
                onClick={() => void openWorkspaceSession(workspacePath, agent.id)}
              >
                <span className="truncate">{t('layout.openWith', { agent: agent.label })}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FilePlus /> {t('layout.newDocumentMenu')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {TYPE_ORDER.map((type) => {
              const { label: typeLabel, icon: Icon } = TYPE_META[type];
              return (
                <ContextMenuItem
                  key={type}
                  onClick={() => openCreateDialog({ workspacePath, type })}
                >
                  <Icon /> {typeLabel}
                </ContextMenuItem>
              );
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={() => onCreateChild(workspacePath)}>
          <FolderPlus /> {t('layout.newSubWorkspace')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => void projectStore.openTodos(isRoot ? null : workspacePath)}
        >
          <ListChecks /> {t('layout.workspaceTodos')}
        </ContextMenuItem>
        <ContextMenuItem onClick={onToggleSections}>
          {sectionsOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
          {sectionsOpen ? t('layout.collapseDocuments') : t('layout.expandDocuments')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void writeClipboardText(workspacePath)}>
          <Copy /> {t('common.copyPath')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!scope}
          onClick={() =>
            scope && void writeClipboardText(absoluteWorkspacePath(scope.root, workspacePath))
          }
        >
          <Copy /> {t('layout.copyAbsolutePath')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void openProjectItem(workspacePath)}>
          <FolderOpen /> {t('layout.openFolder')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void revealProjectItem(workspacePath)}>
          <ExternalLink /> {t('common.reveal')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Hub session rows, listed directly under a workspace header (主页重设计 +
 * 平权): the left pane is the attention-scheduling panel, so a workspace's
 * terminals live here (above status/issue/…) with no section header. A click
 * stages that session in the full-width terminal. Empty → nothing.
 */
function WorkspaceSessionList({
  workspacePath,
}: {
  workspacePath: string;
}): JSX.Element | null {
  const { t } = useTranslation();
  const projections = useSessionProjections();
  const { view, scope } = useProject();
  const hubKey = workspaceAnchorKey(workspacePath);
  const selectedItemId = useSelectedSessionView(scope, hubKey);
  const hubSessions = projections.filter(
    (s) =>
      sessionProjectionAnchorKey(s.anchor) === hubKey,
  );
  if (hubSessions.length === 0) return null;
  const effectiveSelectedKey = selectedItemId ?? hubSessions.at(-1)?.key ?? null;
  const isThisHubView =
    workspacePath === ROOT_WS_PATH
      ? view.kind === 'root'
      : view.kind === 'workspace' && view.path === workspacePath;

  return (
    <div>
      {hubSessions.map((s) => {
        const active = isThisHubView && effectiveSelectedKey === s.key;
        return (
          <ContextMenu key={s.key}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  if (scope) sessionViewStore.select(scope, hubKey, s.key);
                  if (s.kind === 'terminal') void projectStore.activateSession(s.id);
                  else if (workspacePath === ROOT_WS_PATH) void projectStore.selectRoot();
                  else void projectStore.selectWorkspace(workspacePath);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm leading-tight',
                  active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
                aria-label={
                  s.orphanedDocPath
                    ? `${s.title} — ${t('layout.orphanedSessionHint', { path: s.orphanedDocPath })}`
                    : s.title
                }
              >
                <SessionDot state={s.indicator} />
                <span className="truncate">{s.title}</span>
                {s.orphanedDocPath && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="flex shrink-0"
                        role="img"
                        aria-label={t('layout.orphanedSessionHint', { path: s.orphanedDocPath })}
                      >
                        <FileWarning className="h-3.5 w-3.5 text-[var(--rp-gold)]" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('layout.orphanedSessionHint', { path: s.orphanedDocPath })}
                    </TooltipContent>
                  </Tooltip>
                )}
                {s.kind === 'iris-agent' && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/60">Agent</span>}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => void closeProjectedSession(s)}
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
 *   - right-click opens WorkspaceContextMenu anywhere on the header row.
 * No indentation (平铺) — depth is read from the chevron + bold header, not a
 * rail. Only one selection shadow at a time: a staged hub session carries the
 * highlight and the header stays plain; the header highlights only when this
 * hub view shows no session (the launch pad).
 * Orphaned sessions remain visible with a warning so an external document
 * deletion cannot hide work.
 */
function WorkspaceSection({
  ws,
  depth,
  onCreateChild,
}: {
  ws: IrisWorkspace;
  depth: number;
  onCreateChild: (parentPath: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { view, scope } = useProject();
  const prefs = useLeftPanePrefs(scope?.root ?? null);
  const projections = useSessionProjections();
  const isRoot = depth === 0;
  const workspacePath = isRoot ? ROOT_WS_PATH : ws.path;
  const sectionsOpen = prefs.workspaces[workspacePath] ?? isRoot;
  const toggleSections = (): void => {
    if (scope) leftPanePrefs.setWorkspaceOpen(scope.root, workspacePath, isRoot, !sectionsOpen);
  };
  const byType = (t: DocType): IrisDoc[] => ws.docs.filter((d) => d.type === t);

  const isThisHubView = isRoot
    ? view.kind === 'root'
    : view.kind === 'workspace' && view.path === ws.path;
  const hubKey = workspaceAnchorKey(workspacePath);
  const selectedItemId = useSelectedSessionView(scope, hubKey);
  const hubSessions = projections.filter((session) => sessionProjectionAnchorKey(session.anchor) === hubKey);
  const effectiveSelectedKey = selectedItemId ?? hubSessions.at(-1)?.key ?? null;
  const hubSessionStaged = isThisHubView && hubSessions.some((session) => session.key === effectiveSelectedKey);
  const headerSelected = isThisHubView && !hubSessionStaged;
  const hubLabel = isRoot ? t('layout.projectRoot') : ws.name;

  return (
    <div>
      <WorkspaceContextMenu
        workspacePath={workspacePath}
        label={hubLabel}
        isRoot={isRoot}
        sectionsOpen={sectionsOpen}
        onToggleSections={toggleSections}
        onCreateChild={onCreateChild}
      >
        <div
          className={cn(
            'group/hub flex items-center gap-1 rounded-sm pr-1',
            headerSelected
              ? 'bg-accent text-accent-foreground'
              : 'hover:bg-muted data-[state=open]:bg-muted text-foreground',
          )}
        >
          <button
            type="button"
            aria-label={sectionsOpen ? t('layout.collapseDocuments') : t('layout.expandDocuments')}
            onClick={toggleSections}
            className="shrink-0 px-1 py-1.5 text-muted-foreground hover:text-foreground"
          >
            {sectionsOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            aria-label={isRoot ? t('layout.rootHubHint') : t('layout.workspaceHubHint')}
            onClick={() => selectHub(workspacePath)}
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-[13px] font-semibold"
          >
            {isRoot && <FolderRoot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            <span className="truncate">{ws.name}</span>
          </button>
          <NewWorkspaceSessionButton workspacePath={workspacePath} label={hubLabel} />
        </div>
      </WorkspaceContextMenu>
      <div className="space-y-2 pt-1">
        <WorkspaceSessionList workspacePath={workspacePath} />
        {sectionsOpen && (
          <>
            {TYPE_ORDER.map((t) => (
              <TypeSection
                key={t}
                type={t}
                docs={byType(t)}
                workspacePath={ws.path}
              />
            ))}
            <ExternalSection external={ws.external} />
          </>
        )}
        {ws.children.map((c) => (
          <WorkspaceSection key={c.path} ws={c} depth={depth + 1} onCreateChild={onCreateChild} />
        ))}
      </div>
    </div>
  );
}

export function LensTree({ root }: { root: IrisWorkspace }): JSX.Element {
  const [childParent, setChildParent] = useState<string | null>(null);
  return (
    <div className="px-1 py-1">
      <WorkspaceSection ws={root} depth={0} onCreateChild={setChildParent} />
      <CreateWorkspaceDialog
        open={childParent !== null}
        onClose={() => setChildParent(null)}
        defaultParent={childParent ?? undefined}
      />
    </div>
  );
}
