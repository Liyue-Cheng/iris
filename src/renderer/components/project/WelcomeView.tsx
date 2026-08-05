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
import { IrisMark } from '@renderer/components/layout/IrisMark';
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
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center px-6 py-10 sm:px-10 lg:px-14">
        <header className="mb-10 flex items-center gap-4">
          <IrisMark className="h-16 w-16 shrink-0" />
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold text-foreground">Iris</h1>
            <p className="mt-1 text-sm text-muted-foreground">选择一个项目，继续当前工作。</p>
          </div>
        </header>

        <div className="grid gap-10 lg:grid-cols-[minmax(13rem,0.72fr)_minmax(0,1.55fr)] lg:gap-16">
          <section aria-labelledby="welcome-start-title">
            <h2 id="welcome-start-title" className="mb-3 text-sm font-semibold text-foreground">
              开始
            </h2>
            <div className="flex flex-col items-start gap-1">
              <Button
                variant="ghost"
                className="h-9 justify-start px-2 text-primary"
                disabled={opening}
                onClick={() => void chooseFolder()}
              >
                {opening ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                {opening ? '正在打开…' : '打开项目文件夹'}
              </Button>
              <Button
                variant="ghost"
                className="h-9 justify-start px-2 text-primary"
                disabled={opening}
                onClick={() => void chooseFolderInNewWindow()}
              >
                <AppWindow />
                在新窗口打开
              </Button>
            </div>

            {visibleError && (
              <div
                role="alert"
                className="mt-5 flex max-w-sm items-start gap-2 text-xs text-destructive"
              >
                <TriangleAlert className="mt-px h-4 w-4 shrink-0" />
                <span className="break-words">{visibleError}</span>
              </div>
            )}
          </section>

          <section className="min-w-0" aria-labelledby="welcome-recent-title">
            <div className="mb-3 flex h-6 items-center gap-2">
              <h2 id="welcome-recent-title" className="text-sm font-semibold text-foreground">
                近期打开
              </h2>
              {loadingRecents && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>

            {!loadingRecents && recentProjects.length === 0 ? (
              <div className="border-t py-5 text-sm text-muted-foreground">
                还没有近期项目。
              </div>
            ) : (
              <ul className="divide-y divide-border border-y">
                {recentProjects.map((project) => {
                  const removing = removingPath === project.path;
                  return (
                    <li key={project.path} className="group flex min-w-0 items-center gap-1">
                      <button
                        type="button"
                        disabled={opening || !project.exists}
                        title={project.path}
                        onClick={() => void openRecent(project)}
                        className="flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-55"
                      >
                        {project.exists ? (
                          <Folder className="h-4 w-4 shrink-0 text-primary" />
                        ) : (
                          <TriangleAlert className="h-4 w-4 shrink-0 text-destructive" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-foreground">
                            {project.name}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {project.path}
                          </span>
                        </span>
                        {!project.exists && (
                          <span className="shrink-0 text-[11px] text-destructive">路径不可用</span>
                        )}
                      </button>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="mr-1 h-8 w-8 shrink-0 text-muted-foreground"
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
      </div>
    </main>
  );
}
