/**
 * Left pane: lens tree + project-level empty states. The pane header carries
 * project, navigation, and status affordances.
 */
import { useEffect, useState } from 'react';
import {
  AppWindow,
  ArrowDownAZ,
  Clock,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  ListChecks,
  Loader2,
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
import { InitDialog } from '@renderer/components/project/InitDialog';
import { CreateWorkspaceDialog } from '@renderer/components/project/CreateWorkspaceDialog';
import { SourceControlPanel } from '@renderer/components/git/SourceControlPanel';
import { gitStore, useGit } from '@renderer/stores/git-store';

function EmptyState({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function LeftPane(): JSX.Element {
  const { phase, error, scan, view } = useProject();
  const { sort, filter, filterOpen } = useLensPrefs();
  const [initOpen, setInitOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState<string | null>(null);
  const { snapshot: gitSnapshot, loading: gitLoading, pending: gitPending } = useGit();

  useEffect(() => {
    if (phase === 'ready') {
      void gitStore.refresh();
    } else {
      setGitOpen(false);
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
    <div className="flex h-full flex-col bg-card/50">
      {/*
        Header is a pure utility bar: project identity lives once in the lens
        tree's interactive root node (and always-visible in the title-bar crumb),
        so the name is NOT repeated here — that collapsed the stacked "iris ×3".
      */}
      <div className="flex h-11 shrink-0 items-center gap-1 px-2">
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void pickAndOpenProject()}
              >
                <FolderOpen className="!size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>打开项目文件夹</TooltipContent>
          </Tooltip>

          <DropdownMenu onOpenChange={(open) => open && void refreshRecentProjects()}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="打开最近的项目">
                    <History className="!size-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>打开最近的项目</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="start"
              className="max-h-80 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto"
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                最近的项目
              </DropdownMenuLabel>
              {recentLoading ? (
                <DropdownMenuItem disabled>
                  <Loader2 className="animate-spin" />
                  正在读取…
                </DropdownMenuItem>
              ) : recentError ? (
                <div role="alert" className="break-words px-2 py-1.5 text-xs text-destructive">
                  {recentError}
                </div>
              ) : recentProjects.length === 0 ? (
                <DropdownMenuItem disabled>还没有最近项目</DropdownMenuItem>
              ) : (
                recentProjects.map((project) => (
                  <DropdownMenuItem
                    key={project.path}
                    disabled={!project.exists}
                    title={project.path}
                    className="items-start"
                    onClick={() => void openProject(project.path)}
                  >
                    <Folder className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="block truncate">{project.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {project.exists ? project.path : `${project.path}（路径不可用）`}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void openProjectInNewWindow()}
              >
                <AppWindow className="!size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>在新窗口打开项目</TooltipContent>
          </Tooltip>
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
                <TooltipContent>新建工作区（人的手势）</TooltipContent>
              </Tooltip>
              {scan.root && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => lensPrefs.toggleSort()}
                      >
                        {sort === 'mtime' ? (
                          <Clock className="!size-4" />
                        ) : (
                          <ArrowDownAZ className="!size-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {sort === 'mtime' ? '排序：修改时间（点击切字母序）' : '排序：字母序（点击切修改时间）'}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'h-7 w-7',
                          filterOpen && 'bg-accent text-accent-foreground',
                        )}
                        onClick={() => lensPrefs.toggleFilter()}
                      >
                        <Search className="!size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>筛选文档（名称 / 标题）</TooltipContent>
                  </Tooltip>
                </>
              )}
              {scan.root && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'relative h-7 w-7',
                        view.kind === 'todos' && 'bg-accent text-accent-foreground',
                      )}
                      onClick={() => projectStore.openTodos(null)}
                    >
                      <ListChecks className="!size-4" />
                      {todoCount > 0 && (
                        <span className="absolute -right-px -top-px rounded-sm bg-muted px-0.5 text-[9px] leading-3 text-muted-foreground">
                          {todoCount}
                        </span>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>待办面板（活动 issue 的未勾选任务项）</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={phase !== 'ready'}
                    className={cn(
                      'relative h-7 w-7',
                      gitOpen && 'bg-accent text-accent-foreground',
                      (gitLoading || gitPending) && 'text-primary',
                    )}
                    aria-label={`Git 源代码管理：${gitBranch}`}
                    aria-busy={gitLoading || !!gitPending}
                    onClick={() => setGitOpen((open) => !open)}
                  >
                    <GitBranch
                      className={cn(
                        '!size-4',
                        (gitLoading || gitPending) && 'animate-pulse',
                      )}
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
                    ? `Git：${gitSnapshot.branch}（${gitCount} 个变更）`
                    : 'Git 源代码管理'}
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {!gitOpen && phase === 'ready' && scan?.hasIris && filterOpen && (
        <div className="flex h-8 shrink-0 items-center gap-1 px-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={filter}
            placeholder="筛选文档…"
            onChange={(e) => lensPrefs.setFilter(e.target.value.toLowerCase())}
            onKeyDown={(e) => {
              if (e.key === 'Escape') lensPrefs.toggleFilter();
            }}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
          />
          {filter !== '' && (
            <button
              type="button"
              title="清除"
              onClick={() => lensPrefs.setFilter('')}
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {gitOpen ? (
        <div className="min-h-0 flex-1">
          <SourceControlPanel mode="view" refreshOnReady={false} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {phase === 'idle' && (
            <EmptyState>
              <p>打开一个项目开始。</p>
              <Button size="sm" variant="secondary" onClick={() => void pickAndOpenProject()}>
                <FolderOpen /> 打开项目
              </Button>
            </EmptyState>
          )}

          {phase === 'opening' && (
            <EmptyState>
              <Loader2 className="h-4 w-4 animate-spin" />
              <p>正在打开…</p>
            </EmptyState>
          )}

          {phase === 'error' && (
            <EmptyState>
              <p className="text-destructive">打开项目失败</p>
              <p className="max-w-44 break-all text-muted-foreground/70">{error}</p>
              <Button size="sm" variant="secondary" onClick={() => void pickAndOpenProject()}>
                <FolderOpen /> 重新选择
              </Button>
            </EmptyState>
          )}

          {phase === 'ready' && scan && !scan.hasIris && (
            <EmptyState>
              <p>
                该项目还没有 <code className="rounded bg-muted px-1">.iris/</code>
              </p>
              <Button size="sm" variant="secondary" onClick={() => setInitOpen(true)}>
                初始化 Iris 协议
              </Button>
              <p className="max-w-48 text-muted-foreground/70">
                也可以手建 .iris/ 与类型文件夹——协议不需要应用在场。
              </p>
            </EmptyState>
          )}

          {phase === 'ready' && scan?.hasIris && scan.root && (
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
