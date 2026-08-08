import { useCallback, useEffect, useState } from 'react';
import {
  AppWindow,
  Folder,
  FolderOpen,
  Loader2,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { RecentProject } from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { pipeline } from '@renderer/cpu';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { useProject } from '@renderer/stores/project-store';
import {
  openProject,
  openProjectInNewWindow,
  pickAndOpenProject,
} from '@renderer/lib/project-actions';

function PixelStudio(): JSX.Element {
  return (
    <div className="iris-pixel-scene" aria-hidden="true">
      <div className="iris-pixel-backdrop">
        <span className="iris-pixel-star iris-pixel-star-one" />
        <span className="iris-pixel-star iris-pixel-star-two" />
        <span className="iris-pixel-star iris-pixel-star-three" />
        <span className="iris-pixel-moon" />

        <div className="iris-pixel-window">
          <span className="iris-pixel-building iris-pixel-building-one" />
          <span className="iris-pixel-building iris-pixel-building-two" />
          <span className="iris-pixel-building iris-pixel-building-three" />
          {[8, 18, 30, 43, 55, 68, 80, 91].map((left, index) => (
            <span
              key={left}
              className="iris-pixel-rain"
              style={{ left: `${left}%`, animationDelay: `${index * -0.17}s` }}
            />
          ))}
          <span className="iris-pixel-window-bar iris-pixel-window-bar-x" />
          <span className="iris-pixel-window-bar iris-pixel-window-bar-y" />
        </div>

        <div className="iris-pixel-shelf">
          <span className="iris-pixel-book iris-pixel-book-one" />
          <span className="iris-pixel-book iris-pixel-book-two" />
          <span className="iris-pixel-book iris-pixel-book-three" />
          <span className="iris-pixel-box" />
        </div>

        <div className="iris-pixel-plant">
          <span className="iris-pixel-leaf iris-pixel-leaf-one" />
          <span className="iris-pixel-leaf iris-pixel-leaf-two" />
          <span className="iris-pixel-leaf iris-pixel-leaf-three" />
          <span className="iris-pixel-pot" />
        </div>
      </div>

      <div className="iris-pixel-light-cone" />
      <div className="iris-pixel-desk">
        <span className="iris-pixel-desk-edge" />
        <span className="iris-pixel-desk-leg iris-pixel-desk-leg-left" />
        <span className="iris-pixel-desk-leg iris-pixel-desk-leg-right" />
      </div>

      <div className="iris-pixel-lamp">
        <span className="iris-pixel-lamp-shade" />
        <span className="iris-pixel-lamp-neck" />
        <span className="iris-pixel-lamp-base" />
      </div>

      <div className="iris-pixel-monitor">
        <div className="iris-pixel-screen">
          <span className="iris-pixel-screen-dot iris-pixel-screen-dot-one" />
          <span className="iris-pixel-screen-dot iris-pixel-screen-dot-two" />
          <span className="iris-pixel-screen-dot iris-pixel-screen-dot-three" />
          <span className="iris-pixel-screen-rule iris-pixel-screen-rule-one" />
          <span className="iris-pixel-screen-rule iris-pixel-screen-rule-two" />
          <span className="iris-pixel-screen-rule iris-pixel-screen-rule-three" />
          <span className="iris-pixel-screen-check">✓</span>
          <span className="iris-pixel-screen-cursor" />
        </div>
        <span className="iris-pixel-monitor-light" />
        <span className="iris-pixel-monitor-neck" />
        <span className="iris-pixel-monitor-base" />
      </div>

      <div className="iris-pixel-pages">
        <span className="iris-pixel-page iris-pixel-page-one" />
        <span className="iris-pixel-page iris-pixel-page-two" />
        <span className="iris-pixel-page-line iris-pixel-page-line-one" />
        <span className="iris-pixel-page-line iris-pixel-page-line-two" />
      </div>
      <span className="iris-pixel-floating-page" />
      <span className="iris-pixel-cup" />
      <span className="iris-pixel-steam iris-pixel-steam-one" />
      <span className="iris-pixel-steam iris-pixel-steam-two" />
      <span className="iris-pixel-foreground" />
    </div>
  );
}

export function WelcomeView(): JSX.Element {
  const { phase, error: projectError } = useProject();
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [loadingRecents, setLoadingRecents] = useState(true);
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const opening = phase === 'opening';

  const refreshRecents = useCallback(async (): Promise<void> => {
    setLoadingRecents(true);
    try {
      const projects = await window.api.invoke<undefined, RecentProject[]>(
        CHANNELS.PROJECT_RECENT_LIST,
      );
      setRecentProjects(projects);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingRecents(false);
    }
  }, []);

  useEffect(() => {
    void refreshRecents();
  }, [refreshRecents]);

  const chooseFolder = async (): Promise<void> => {
    if (opening) return;
    setActionError(null);
    try {
      await pickAndOpenProject();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const chooseFolderInNewWindow = async (): Promise<void> => {
    setActionError(null);
    try {
      await openProjectInNewWindow();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const openRecent = async (project: RecentProject): Promise<void> => {
    if (opening || !project.exists) return;
    setActionError(null);
    await openProject(project.path);
  };

  const removeRecent = async (path: string): Promise<void> => {
    if (removingPath) return;
    setActionError(null);
    setRemovingPath(path);
    try {
      await pipeline.dispatch('project.recent-remove', { path });
      setRecentProjects((current) => current.filter((project) => project.path !== path));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingPath(null);
    }
  };

  const visibleError = actionError ?? (phase === 'error' ? projectError : null);

  return (
    <main className="h-full overflow-y-auto bg-background">
      <div className="mx-auto grid min-h-full w-full max-w-[1360px] content-start items-start gap-12 px-8 py-12 lg:grid-cols-[minmax(350px,0.72fr)_minmax(560px,1.28fr)] lg:gap-20 lg:px-6 lg:pt-[clamp(64px,9vh,92px)] xl:px-8">
        <div className="min-w-0">
          <header>
            <h1 className="text-[28px] leading-tight text-foreground">
              <span className="font-semibold">Iris</span>
              <span className="text-muted-foreground"> - Agent Development Environment</span>
            </h1>
          </header>

          <section className="mt-10" aria-labelledby="welcome-start-title">
            <h2 id="welcome-start-title" className="mb-2.5 text-lg font-medium text-foreground">
              开始
            </h2>
            <div className="flex flex-col items-start gap-0.5">
              <Button
                variant="ghost"
                className="h-8 justify-start px-1.5 font-normal text-primary hover:bg-primary/10 hover:text-primary"
                disabled={opening}
                onClick={() => void chooseFolder()}
              >
                {opening ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                {opening ? '正在打开…' : '打开项目文件夹'}
              </Button>
              <Button
                variant="ghost"
                className="h-8 justify-start px-1.5 font-normal text-primary hover:bg-primary/10 hover:text-primary"
                disabled={opening}
                onClick={() => void chooseFolderInNewWindow()}
              >
                <AppWindow />
                在新窗口打开
              </Button>
            </div>
          </section>

          {visibleError && (
            <div role="alert" className="mt-5 flex items-start gap-2 text-xs text-destructive">
              <TriangleAlert className="mt-px h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{visibleError}</span>
            </div>
          )}

          <section className="mt-9 min-w-0" aria-labelledby="welcome-recent-title">
            <h2 id="welcome-recent-title" className="mb-2.5 text-lg font-medium text-foreground">
              近期
            </h2>

            {loadingRecents ? (
              <div className="space-y-1" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-8 animate-pulse rounded-sm bg-muted/70" />
                ))}
              </div>
            ) : recentProjects.length === 0 ? (
              <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <Folder className="h-4 w-4" />
                还没有近期项目
              </div>
            ) : (
              <ul className="flex flex-col gap-px">
                {recentProjects.map((project) => {
                  const removing = removingPath === project.path;
                  return (
                    <li key={project.path} className="group relative flex min-w-0 items-center">
                      <button
                        type="button"
                        disabled={opening || !project.exists}
                        title={project.path}
                        onClick={() => void openRecent(project)}
                        className="grid h-8 min-w-0 flex-1 grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)] items-center gap-3 rounded-sm px-1.5 pr-9 text-left outline-none transition-colors hover:bg-accent/55 focus-visible:bg-accent/55 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        <span
                          className={
                            project.exists
                              ? 'truncate text-sm text-primary'
                              : 'truncate text-sm text-muted-foreground'
                          }
                        >
                          {project.name}
                        </span>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-xs text-muted-foreground/80">
                            {project.path}
                          </span>
                          {!project.exists && (
                            <span className="shrink-0 text-[10px] text-destructive">路径不可用</span>
                          )}
                        </span>
                      </button>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="absolute right-0 top-1/2 h-7 w-7 -translate-y-1/2 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                            disabled={!!removingPath || opening}
                            aria-label={`从近期项目中移除 ${project.name}`}
                            onClick={() => void removeRecent(project.path)}
                          >
                            {removing ? <Loader2 className="animate-spin" /> : <X />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>从近期项目中移除</TooltipContent>
                      </Tooltip>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <div className="mx-auto w-full max-w-[720px] justify-self-center lg:pt-10">
          <PixelStudio />
        </div>
      </div>
    </main>
  );
}
