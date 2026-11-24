/**
 * Left pane: lens tree + project-level empty states. The pane header carries
 * project, navigation, and status affordances.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppWindow,
  ArrowDownAZ,
  Clock,
  Folder,
  FolderOpen,
  FolderPlus,
  Files,
  GitBranch,
  ListChecks,
  ListTree,
  Loader2,
  MoreHorizontal,
  Search,
  X,
} from 'lucide-react';
import type { RecentProject } from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { collectTodos } from '@renderer/lib/collect-docs';
import { cn } from '@renderer/lib/utils';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { projectStore, useProject } from '@renderer/stores/project-store';
import { lensPrefs, useLensPrefs } from '@renderer/stores/lens-prefs';
import {
  openProject,
  openProjectInNewWindow,
  pickAndOpenProject,
} from '@renderer/lib/project-actions';
import { LensTree } from '@renderer/components/lens/LensTree';
import { RawTree } from '@renderer/components/lens/RawTree';
import { InitDialog } from '@renderer/components/project/InitDialog';
import { CreateWorkspaceDialog } from '@renderer/components/project/CreateWorkspaceDialog';
import { SourceControlPanel } from '@renderer/components/git/SourceControlPanel';
import { gitStore, useGit } from '@renderer/stores/git-store';
import { useProjectSettings } from '@renderer/stores/project-settings-store';
import {
  LucideDynamicIcon,
  isLucideIconName,
} from '@renderer/components/ui/lucide-dynamic-icon';
import { runProjectToolbarAction } from '@renderer/lib/project-command-actions';
import { alertDialog } from '@renderer/components/ui/confirm-dialog';
import { useLeftPanePrefs, type LeftPaneMode } from '@renderer/lib/left-pane-prefs';

function EmptyState({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function ProjectToolbarActions(): JSX.Element | null {
  const { t } = useTranslation();
  const { snapshot } = useProjectSettings();
  const actions = snapshot?.settings.toolbar.actions ?? [];
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [slots, setSlots] = useState(1);
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);

  const setContainer = useCallback((element: HTMLDivElement | null): void => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (!element) return;
    const update = (): void => setSlots(Math.max(1, Math.floor(element.clientWidth / 32)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    resizeObserverRef.current = observer;
  }, []);

  if (!snapshot || snapshot.error || actions.length === 0) return null;
  const visibleCount = actions.length <= slots ? actions.length : Math.max(0, slots - 1);
  const visible = actions.slice(0, visibleCount);
  const overflow = actions.slice(visibleCount);

  const run = async (index: number): Promise<void> => {
    const action = actions[index];
    if (!action || !isLucideIconName(action.icon)) return;
    setPendingIndex(index);
    try {
      await runProjectToolbarAction(index, action, snapshot);
    } catch (err) {
      await alertDialog({
        title: t('projectSettings.runFailed'),
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPendingIndex(null);
    }
  };

  return (
    <div
      ref={setContainer}
      className="flex min-w-7 flex-1 items-center justify-end gap-1 overflow-hidden"
    >
      {visible.map((action, index) => (
        <Tooltip key={`${index}:${action.icon}:${action.description}`}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              aria-label={action.description}
              disabled={pendingIndex !== null || !isLucideIconName(action.icon)}
              onClick={() => void run(index)}
            >
              {pendingIndex === index ? (
                <Loader2 className="!size-4 animate-spin" />
              ) : (
                <LucideDynamicIcon name={action.icon} className="!size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{action.description}</TooltipContent>
        </Tooltip>
      ))}
      {overflow.length > 0 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label={t('projectSettings.moreActions')}
                >
                  <MoreHorizontal className="!size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t('projectSettings.moreActions')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="max-w-80">
            {overflow.map((action, overflowIndex) => {
              const index = visibleCount + overflowIndex;
              return (
                <DropdownMenuItem
                  key={`${index}:${action.icon}:${action.description}`}
                  disabled={pendingIndex !== null || !isLucideIconName(action.icon)}
                  onClick={() => void run(index)}
                >
                  <LucideDynamicIcon name={action.icon} className="h-4 w-4" />
                  <span className="truncate">{action.description}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function LeftPane(): JSX.Element {
  const { t } = useTranslation();
  const { phase, error, scope, scan, view, rawTree } = useProject();
  const leftPanePrefs = useLeftPanePrefs(scope?.root ?? null);
  const mode = leftPanePrefs.mode ?? 'documents';
  const filesOpen = mode === 'files';
  const gitOpen = mode === 'git';
  const { sort, filter } = useLensPrefs();
  const sortLabel = t(filesOpen
    ? (sort === 'mtime' ? 'layout.fileSortMtime' : 'layout.fileSortAlpha')
    : (sort === 'mtime' ? 'layout.sortMtime' : 'layout.sortAlpha'));
  const filterLabel = t(filesOpen ? 'layout.filterFiles' : 'layout.filterDocuments');
  // Views are a fixed three-way choice; clicking the active view is a no-op
  // (no hidden "click again to go back" toggle).
  const selectMode = (next: LeftPaneMode): void => {
    if (next === mode) return;
    void projectStore.setLeftPaneMode(next).catch((err) => {
      console.warn('[left-pane] view switch failed', err);
    });
  };
  const [initOpen, setInitOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState<string | null>(null);
  const { snapshot: gitSnapshot, loading: gitLoading, pending: gitPending } = useGit();

  useEffect(() => {
    if (phase === 'ready') {
      void gitStore.refresh();
    }
  }, [phase]);

  const todoCount =
    phase === 'ready' && scan?.root ? collectTodos(scan.root, null).length : 0;

  const gitCount = gitSnapshot
    ? Object.values(gitSnapshot.groups).reduce((total, resources) => total + resources.length, 0)
    : 0;
  const gitBranch = gitSnapshot?.branch ?? (gitSnapshot?.detached ? 'HEAD' : 'Git');

  const refreshRecentProjects = async (): Promise<void> => {
    setRecentLoading(true);
    setRecentError(null);
    try {
      const projects = await window.api.invoke<undefined, RecentProject[]>(
        CHANNELS.PROJECT_RECENT_LIST,
      );
      setRecentProjects(projects);
    } catch (err) {
      setRecentError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecentLoading(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/*
        Header is a pure utility bar: project identity lives once in the lens
        tree's interactive root node (and always-visible in the title-bar crumb),
        so the name is NOT repeated here — that collapsed the stacked "iris ×3".
      */}
      {/* Right edge: pr-[13px] puts the rightmost 28px button's center 27px from
          the pane edge — the same column as the view tool row's sort button and
          the tree's "+" buttons (see the tool row comment below). */}
      <div className="flex h-11 shrink-0 items-center gap-1 pl-2 pr-[13px]">
        <div className="flex items-center">
          <DropdownMenu onOpenChange={(open) => open && void refreshRecentProjects()}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={t('layout.projectMenu')}
                  >
                    <FolderOpen className="!size-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('layout.projectMenu')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="start"
              className="max-h-80 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto"
            >
              <DropdownMenuItem onClick={() => void pickAndOpenProject()}>
                <FolderOpen />
                {t('app.openProject')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t('layout.recentProjects')}
              </DropdownMenuLabel>
              {recentLoading ? (
                <DropdownMenuItem disabled>
                  <Loader2 className="animate-spin" />
                  {t('common.loading')}
                </DropdownMenuItem>
              ) : recentError ? (
                <div role="alert" className="break-words px-2 py-1.5 text-xs text-destructive">
                  {recentError}
                </div>
              ) : recentProjects.length === 0 ? (
                <DropdownMenuItem disabled>{t('project.noRecent')}</DropdownMenuItem>
              ) : (
                recentProjects.map((project) => (
                  <DropdownMenuItem
                    key={project.path}
                    disabled={!project.exists}
                    aria-label={project.path}
                    className="items-start"
                    onClick={() => void openProject(project.path)}
                  >
                    <Folder className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="block truncate">{project.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {project.exists ? project.path : `${project.path} (${t('project.pathUnavailable')})`}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void openProjectInNewWindow()}>
                <AppWindow />
                {t('app.openProjectNewWindow')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {phase === 'ready' && scan?.hasIris && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setWsOpen(true)}
                  >
                    <FolderPlus className="!size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('layout.newWorkspaceHuman')}</TooltipContent>
              </Tooltip>
              {scan.root && (
                <div
                  role="group"
                  aria-label={t('layout.leftPaneViews')}
                  className="ml-1 flex items-center gap-px"
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-7 w-7', mode === 'documents' && 'bg-accent text-accent-foreground')}
                        aria-label={t('layout.documentsView')}
                        aria-pressed={mode === 'documents'}
                        onClick={() => selectMode('documents')}
                      >
                        <ListTree className="!size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('layout.documentsView')}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-7 w-7', filesOpen && 'bg-accent text-accent-foreground')}
                        aria-label={t('layout.fileTree')}
                        aria-pressed={filesOpen}
                        onClick={() => selectMode('files')}
                      >
                        <Files className="!size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('layout.fileTree')}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'relative h-7 w-7',
                          gitOpen && 'bg-accent text-accent-foreground',
                          (gitLoading || gitPending) && 'text-primary',
                        )}
                        aria-label={t('layout.gitAria', { branch: gitBranch })}
                        aria-pressed={gitOpen}
                        aria-busy={gitLoading || !!gitPending}
                        onClick={() => selectMode('git')}
                      >
                        <GitBranch
                          className={cn('!size-4', (gitLoading || gitPending) && 'animate-pulse')}
                        />
                        {gitCount > 0 && (
                          <span className="absolute -right-px -top-px min-w-3 rounded-sm bg-muted px-0.5 text-[9px] leading-3 text-muted-foreground">
                            {gitCount}
                          </span>
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {gitSnapshot?.branch
                        ? t('layout.gitSummary', { branch: gitSnapshot.branch, count: gitCount })
                        : t('git.sourceControl')}
                    </TooltipContent>
                  </Tooltip>
                </div>
              )}
              {scan.root && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'relative ml-1 h-7 w-7',
                        view.kind === 'todos' && 'bg-accent text-accent-foreground',
                      )}
                      aria-label={t('layout.todosHint')}
                      aria-pressed={view.kind === 'todos'}
                      onClick={() => projectStore.toggleTodos()}
                    >
                      <ListChecks className="!size-4" />
                      {todoCount > 0 && (
                        <span className="absolute -right-px -top-px rounded-sm bg-muted px-0.5 text-[9px] leading-3 text-muted-foreground">
                          {todoCount}
                        </span>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('layout.todosHint')}</TooltipContent>
                </Tooltip>
              )}
            </>
          )}
        </div>
        <ProjectToolbarActions />
      </div>

      {/* View-local tools: they belong to the list below, so they switch with
          it. The header row above never changes shape between views. 
          The row's pr-[13px] centers the sort icon on the tree's "+" column:
          10px reserved scrollbar gutter + LensTree px-1 + row pr-1 + half the
          18px "+" button = 27px = 13px + half of the 28px sort button. */}
      {!gitOpen && phase === 'ready' && scan?.hasIris && scan.root && (
        <div className="flex h-9 shrink-0 items-center gap-1 pb-1 pl-2 pr-[13px]">
          <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-muted/60 px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={filter}
              placeholder={t(filesOpen ? 'layout.fileFilterPlaceholder' : 'layout.filterPlaceholder')}
              aria-label={filterLabel}
              onChange={(e) => lensPrefs.setFilter(e.target.value.toLowerCase())}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  lensPrefs.setFilter('');
                  e.currentTarget.blur();
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
            />
            {filter !== '' && (
              <button
                type="button"
                aria-label={t('common.clear')}
                onClick={() => lensPrefs.setFilter('')}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                aria-label={sortLabel}
                onClick={() => lensPrefs.toggleSort()}
              >
                {sort === 'mtime' ? <Clock className="!size-4" /> : <ArrowDownAZ className="!size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{sortLabel}</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* The tree container always reserves the scrollbar gutter, so the
          right-edge "+" column (and the sort button aligned to it) does not
          shift when the list starts or stops overflowing. */}
      {gitOpen ? (
        <div className="min-h-0 flex-1">
          <SourceControlPanel mode="view" refreshOnReady={false} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {phase === 'idle' && (
            <EmptyState>
              <p>{t('layout.startOpenProject')}</p>
              <Button size="sm" variant="secondary" onClick={() => void pickAndOpenProject()}>
                <FolderOpen /> {t('layout.openProject')}
              </Button>
            </EmptyState>
          )}

          {phase === 'opening' && (
            <EmptyState>
              <Loader2 className="h-4 w-4 animate-spin" />
              <p>{t('layout.openingProject')}</p>
            </EmptyState>
          )}

          {phase === 'error' && (
            <EmptyState>
              <p className="text-destructive">{t('layout.projectOpenFailed')}</p>
              <p className="max-w-44 break-all text-muted-foreground/70">{error}</p>
              <Button size="sm" variant="secondary" onClick={() => void pickAndOpenProject()}>
                <FolderOpen /> {t('layout.chooseAgain')}
              </Button>
            </EmptyState>
          )}

          {phase === 'ready' && scan && !scan.hasIris && (
            <EmptyState>
              <p>{t('layout.noIris')}</p>
              <Button size="sm" variant="secondary" onClick={() => setInitOpen(true)}>
                {t('layout.initializeIris')}
              </Button>
              <p className="max-w-48 text-muted-foreground/70">
                {t('layout.manualInit')}
              </p>
            </EmptyState>
          )}

          {phase === 'ready' && scan?.hasIris && filesOpen && rawTree && (
            <RawTree key={rawTree.absolutePath} root={rawTree} />
          )}
          {phase === 'ready' && scan?.hasIris && mode === 'documents' && scan.root && (
            <LensTree root={scan.root} />
          )}
        </div>
      )}

      <InitDialog
        open={initOpen}
        onClose={() => setInitOpen(false)}
      />
      <CreateWorkspaceDialog open={wsOpen} onClose={() => setWsOpen(false)} />
    </div>
  );
}
