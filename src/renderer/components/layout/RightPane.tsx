/**
 * Right pane — the session panel (软件定义书 §5 右栏). Sessions anchor to
 * docs; the project-root session is the unfocused fallback. Detach, not
 * dispatch: sessions stay interactive, the user walks away and comes back.
 *
 * Round-3 E-1/E-2 form: the pane shows ONLY the sessions of the middle
 * pane's anchor — the selected doc's sessions, or the project-root sessions
 * when the root node is selected (no mixing). The old session tab strip is
 * gone; the header is a terminal BANNER: click to switch between this
 * anchor's sessions (close lives in that menu), + on the right to spawn a
 * new one. No session under the anchor → a full-page launch pad (Marina 式
 * EmptyPathState, F-1): spawn happens only on an explicit click.
 */
import { useState } from 'react';
import { ChevronDown, Plus, X, FileText, FolderRoot, SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentConfig } from '@shared/types';
import {
  useSessions,
  selectedSessionIdForAnchor,
  sessionAnchorKey,
  workspaceAnchorKey,
} from '@renderer/stores/session-store';
import { useSettings } from '@renderer/stores/settings-store';
import { projectStore, useProject } from '@renderer/stores/project-store';
import { closeSession, openSession, openWorkspaceSession } from '@renderer/lib/session-actions';
import { docDisplayTitle, findDocByPath } from '@renderer/lib/doc-utils';
import { TerminalView } from '@renderer/components/terminal/TerminalView';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
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

const LAUNCHER_SEARCH_THRESHOLD = 6;

function matchingLaunchers(agents: readonly AgentConfig[], query: string): AgentConfig[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...agents];
  return agents.filter(
    (agent) =>
      agent.label.toLocaleLowerCase().includes(needle) ||
      agent.command.toLocaleLowerCase().includes(needle),
  );
}

export function LauncherMenuItems({
  agents,
  onSelect,
}: {
  agents: readonly AgentConfig[];
  onSelect: (agentId: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const visible = matchingLaunchers(agents, query);

  return (
    <>
      {agents.length > LAUNCHER_SEARCH_THRESHOLD && (
        <div className="p-1" onKeyDown={(event) => event.stopPropagation()}>
          <Input
            value={query}
            className="h-8"
            placeholder={t('common.search')}
            aria-label={t('settings.searchLaunchers')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {visible.map((agent) => (
        <DropdownMenuItem key={agent.id} onClick={() => onSelect(agent.id)}>
          {t('layout.openWith', { agent: agent.label })}
        </DropdownMenuItem>
      ))}
      {visible.length === 0 && (
        <div className="px-2 py-3 text-center text-xs text-muted-foreground">
          {t('common.noMatches')}
        </div>
      )}
    </>
  );
}

export function RightPane(): JSX.Element {
  const { t } = useTranslation();
  const { sessions } = useSessions();
  const settings = useSettings();
  const { phase, view, scan } = useProject();
  const agents = settings?.agents ?? [];
  const [launcherQuery, setLauncherQuery] = useState('');
  const visibleLaunchers = matchingLaunchers(agents, launcherQuery);
  const projectReady = phase === 'ready';

  // The pane's anchor mirrors the middle pane: a selected doc, or a workspace
  // hub (root node / sub-workspace selected). Hub sessions carry no FOCUS_DOC;
  // they group by `ws:<workspacePath>` key. Doc sessions key by their path.
  const isHub = view.kind === 'root' || view.kind === 'workspace';
  const hubWorkspacePath = view.kind === 'workspace' ? view.path : '.iris';
  const selectedPath = view.kind === 'doc' ? view.path : null;
  const anchorKey: string | null =
    view.kind === 'root'
      ? workspaceAnchorKey('.iris')
      : view.kind === 'workspace'
        ? workspaceAnchorKey(view.path)
        : selectedPath;
  // D5: show the doc's display title (frontmatter title), not the filename.
  const anchorDoc = !isHub && selectedPath && scan?.root ? findDocByPath(scan.root, selectedPath) : null;
  const anchorName = isHub
    ? view.kind === 'workspace'
      ? (view.path.split('/').pop() ?? view.path)
      : t('layout.projectRoot')
    : selectedPath
      ? anchorDoc
        ? docDisplayTitle(anchorDoc)
        : (selectedPath.split('/').pop()?.replace(/\.md$/i, '') ?? selectedPath)
      : t('layout.projectRoot');
  const AnchorIcon = isHub ? FolderRoot : FileText;

  const spawn = (agentId: string): void => {
    if (isHub) void openWorkspaceSession(hubWorkspacePath, agentId);
    else void openSession(selectedPath, agentId);
  };

  const visibleSessions =
    !projectReady || anchorKey === null
      ? []
      : sessions.filter((s) => sessionAnchorKey(s) === anchorKey);
  // Never show a terminal whose session is outside the current anchor; if
  // the staged id points elsewhere but this anchor HAS sessions, fall back
  // to the newest one (display-level only — no state mutation in render).
  const shownSession =
    visibleSessions.find((s) => s.id === (anchorKey ? selectedSessionIdForAnchor(anchorKey) : null)) ??
    visibleSessions[visibleSessions.length - 1] ??
    null;

  return (
    <div className="flex h-full flex-col bg-card/50">
      {/* Terminal banner — aligned (h-11) with the other panes' first rows. */}
      <div className="flex h-11 shrink-0 items-center gap-1 px-2">
        {shownSession ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex min-w-0 flex-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      title={t('layout.switchSession')}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[13px] hover:bg-muted/60"
                    >
                      <SessionDot state={shownSession.state} />
                      {/* Title bar shows the live terminal title (OSC 0/2),
                          falling back to the agent label until one arrives.
                          The agent identity stays available in the dropdown,
                          so the title bar shows only the live title. */}
                      <span className="min-w-0 truncate font-medium">
                        {shownSession.terminalTitle ?? shownSession.displayName}
                      </span>
                      {shownSession.state === 'exited' && (
                        <span className="shrink-0 text-[11px] text-muted-foreground/60">
                          exit {shownSession.exitCode}
                        </span>
                      )}
                      {visibleSessions.length > 1 && (
                        <span className="shrink-0 text-[11px] text-muted-foreground/60">
                          {visibleSessions.indexOf(shownSession) + 1}/{visibleSessions.length}
                        </span>
                      )}
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="w-max min-w-64 max-w-[32rem]"
                  >
                    <DropdownMenuLabel className="truncate">
                      {t('layout.sessionsFor', { name: anchorName })}
                    </DropdownMenuLabel>
                    {visibleSessions.map((s) => (
                      <DropdownMenuItem
                        key={s.id}
                        onClick={() => void projectStore.activateSession(s.id)}
                        className="flex items-center gap-1.5"
                      >
                        <SessionDot state={s.state} />
                        <span className="shrink-0 font-medium">{s.displayName}</span>
                        {s.terminalTitle && (
                          <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
                            {s.terminalTitle}
                          </span>
                        )}
                        {s.state === 'exited' && (
                          <span className="shrink-0 text-[11px] text-muted-foreground/60">
                            exit {s.exitCode}
                          </span>
                        )}
                        {s.id === shownSession.id && (
                          <span className="shrink-0 text-[11px] text-muted-foreground/60">{t('common.current')}</span>
                        )}
                        <button
                          type="button"
                          title={t('layout.closeSession')}
                          onClick={(e) => {
                            e.stopPropagation();
                            void closeSession(s.id);
                          }}
                          className="ml-auto shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => void closeSession(shownSession.id)}>
                {t('layout.closeSession')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-[13px] text-muted-foreground">
            <AnchorIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{anchorName}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground/60">{t('layout.noSession')}</span>
          </span>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              title={t('layout.newSession')}
              disabled={!projectReady}
            >
              <Plus className="!size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
            <DropdownMenuLabel className="max-w-52 truncate">
              {isHub ? t('layout.workspaceFallback', { name: anchorName }) : t('layout.attachedTo', { name: anchorName })}
            </DropdownMenuLabel>
            <LauncherMenuItems agents={agents} onSelect={spawn} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* One mounted terminal, keyed by sessionId: switching sessions
            unmounts the old xterm and mounts + replays the next (Marina's
            state-replay protocol; the main process's headless mirror is the
            source of truth, so buffers survive any number of remounts). The
            earlier keep-alive scaffolding (hidden display:none instances kept
            streaming) was removed — letting xterm render under display:none
            corrupted its WebGL atlas/geometry caches and produced the切回
            排版混乱 regression; the replay-on-switch it tried to avoid was only
            ever slow because dev ran a stale asar bundle (see issue
            2026-06-25-开发版与安装版实例隔离). */}
        {shownSession && (
          <div className="absolute inset-0">
            <TerminalView key={shownSession.id} sessionId={shownSession.id} />
          </div>
        )}
        {!shownSession &&
          (projectReady ? (
            /* Full-page launch pad (F-1) — spawn only on explicit click. */
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <SquareTerminal className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="max-w-64 truncate text-sm">
                {isHub ? (
                  <>
                    {t('layout.workspaceSession', { name: anchorName })}
                  </>
                ) : (
                  <>
                    {t('layout.documentSession', { name: anchorName })}
                  </>
                )}
              </p>
              <p className="mt-1 max-w-64 text-xs text-muted-foreground">
                {isHub
                  ? t('layout.workspaceContext')
                  : t('layout.documentContext')}
              </p>
            </div>
            <div className="flex max-h-[min(24rem,55vh)] w-64 flex-col gap-2 overflow-y-auto pr-1">
              {agents.length > LAUNCHER_SEARCH_THRESHOLD && (
                <Input
                  value={launcherQuery}
                  className="shrink-0"
                  placeholder={t('common.search')}
                  aria-label={t('settings.searchLaunchers')}
                  onChange={(event) => setLauncherQuery(event.target.value)}
                />
              )}
              {visibleLaunchers.map((a) => (
                <Button
                  key={a.id}
                  variant="secondary"
                  className="h-9 justify-start gap-2 px-4"
                  onClick={() => spawn(a.id)}
                >
                  <SquareTerminal className="!size-4 text-muted-foreground" />
                  {t('layout.openWith', { agent: a.label })}
                </Button>
              ))}
              {visibleLaunchers.length === 0 && (
                <p className="py-4 text-xs text-muted-foreground">{t('common.noMatches')}</p>
              )}
            </div>
            <p className="max-w-64 text-xs text-muted-foreground/70">
              {t('layout.anchorHelp')}
            </p>
          </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
              <p>{t('layout.noSessions')}</p>
              <p className="max-w-56 text-xs text-muted-foreground/70">{t('layout.openProjectFirst')}</p>
            </div>
          ))}
      </div>
    </div>
  );
}
