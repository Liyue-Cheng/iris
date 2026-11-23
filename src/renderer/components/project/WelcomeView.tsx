import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

const PIXEL_RAIN = [
  { x: 18, height: 3, delay: 0 },
  { x: 23, height: 3, delay: -0.15 },
  { x: 29, height: 4, delay: -0.3 },
  { x: 34, height: 3, delay: -0.45 },
  { x: 40, height: 3, delay: -0.6 },
  { x: 45, height: 4, delay: -0.75 },
  { x: 51, height: 3, delay: -0.9 },
  { x: 57, height: 3, delay: -1.05 },
  { x: 62, height: 4, delay: -1.2 },
  { x: 66, height: 3, delay: -1.35 },
];

const PIXEL_TYPED_DELAYS = [0.6, 0.8, 1, 1.2, 1.4];

function PixelStudio(): JSX.Element {
  return (
    <div className="iris-pixel-scene" aria-hidden="true">
      <svg className="iris-pixel-art" viewBox="0 0 160 110">
        <defs>
          <clipPath id="iris-pixel-win-clip">
            <rect x={16} y={12} width={52} height={40} />
          </clipPath>
          <clipPath id="iris-pixel-scene-clip">
            <rect x={0} y={0} width={160} height={110} />
          </clipPath>
        </defs>
        <g clipPath="url(#iris-pixel-scene-clip)">
          {/* 墙 */}
          <rect x={0} y={0} width={160} height={96} fill="var(--pixel-wall)" />
          <g fill="var(--pixel-wall-dot)">
            <rect x={6} y={6} width={1} height={1} />
            <rect x={24} y={3} width={1} height={1} />
            <rect x={47} y={6} width={1} height={1} />
            <rect x={82} y={4} width={1} height={1} />
            <rect x={92} y={34} width={1} height={1} />
            <rect x={88} y={62} width={1} height={1} />
            <rect x={114} y={6} width={1} height={1} />
            <rect x={150} y={10} width={1} height={1} />
            <rect x={146} y={46} width={1} height={1} />
            <rect x={142} y={66} width={1} height={1} />
            <rect x={30} y={72} width={1} height={1} />
            <rect x={8} y={46} width={1} height={1} />
          </g>
          <rect x={0} y={94} width={160} height={2} fill="var(--pixel-wood-dark)" opacity={0.5} />

          {/* 窗户 */}
          <rect x={12} y={8} width={60} height={48} fill="var(--pixel-wood-dark)" />
          <rect x={16} y={12} width={52} height={40} fill="var(--pixel-sky)" />
          <g clipPath="url(#iris-pixel-win-clip)">
            <rect className="iris-pixel-star-a" x={21} y={17} width={1} height={1} fill="var(--pixel-cream)" />
            <rect className="iris-pixel-star-b" x={58} y={15} width={1} height={1} fill="var(--pixel-cream)" />
            <rect x={33} y={22} width={1} height={1} fill="var(--pixel-cream)" opacity={0.7} />
            <rect x={64} y={28} width={1} height={1} fill="var(--pixel-cream)" opacity={0.55} />
            <rect x={26} y={27} width={1} height={1} fill="var(--pixel-cream)" opacity={0.4} />
            <rect x={52} y={14} width={7} height={7} fill="var(--pixel-gold)" />
            <rect x={56} y={13} width={5} height={6} fill="var(--pixel-sky)" />
            <rect x={16} y={36} width={14} height={16} fill="var(--pixel-city)" />
            <rect x={30} y={41} width={8} height={11} fill="var(--pixel-city)" />
            <rect x={38} y={37} width={12} height={15} fill="var(--pixel-city)" />
            <rect x={50} y={42} width={13} height={10} fill="var(--pixel-city)" />
            <rect x={63} y={38} width={5} height={14} fill="var(--pixel-city)" />
            <rect x={19} y={39} width={1} height={1} fill="var(--pixel-gold)" opacity={0.85} />
            <rect x={25} y={45} width={1} height={1} fill="var(--pixel-gold)" opacity={0.8} />
            <rect x={34} y={44} width={1} height={1} fill="var(--pixel-gold)" opacity={0.7} />
            <rect x={41} y={40} width={1} height={1} fill="var(--pixel-gold)" opacity={0.85} />
            <rect className="iris-pixel-city-win" x={46} y={47} width={1} height={1} fill="var(--pixel-gold)" />
            <rect x={55} y={45} width={1} height={1} fill="var(--pixel-gold)" opacity={0.75} />
            <rect x={66} y={41} width={1} height={1} fill="var(--pixel-gold)" opacity={0.8} />
            <rect x={65} y={48} width={1} height={1} fill="var(--pixel-gold)" opacity={0.55} />
            <g fill="var(--pixel-blue)" opacity={0.55}>
              {PIXEL_RAIN.map((drop) => (
                <rect
                  key={drop.x}
                  className="iris-pixel-rain"
                  x={drop.x}
                  y={6}
                  width={1}
                  height={drop.height}
                  style={{ animationDelay: `${drop.delay}s` }}
                />
              ))}
            </g>
          </g>
          <rect x={42} y={12} width={2} height={40} fill="var(--pixel-wood-dark)" />
          <rect x={16} y={30} width={52} height={2} fill="var(--pixel-wood-dark)" />
          <rect x={10} y={56} width={64} height={3} fill="var(--pixel-wood-face)" />
          <rect x={10} y={59} width={64} height={1} fill="var(--pixel-ink)" opacity={0.45} />

          {/* 窗光的冷色溢出 */}
          <polygon points="18,60 66,60 62,82 22,82" fill="var(--pixel-sky)" opacity={0.06} />

          {/* 画框（鸢尾花） */}
          <rect x={96} y={14} width={18} height={16} fill="var(--pixel-wood-dark)" />
          <rect x={98} y={16} width={14} height={12} fill="var(--pixel-sky)" />
          <g fill="var(--pixel-iris)">
            <rect x={104} y={18} width={2} height={2} />
            <rect x={104} y={24} width={2} height={2} />
            <rect x={101} y={21} width={2} height={2} />
            <rect x={107} y={21} width={2} height={2} />
            <rect x={102} y={19} width={1} height={1} />
            <rect x={107} y={19} width={1} height={1} />
            <rect x={102} y={24} width={1} height={1} />
            <rect x={107} y={24} width={1} height={1} />
          </g>
          <rect x={104} y={21} width={2} height={2} fill="var(--pixel-gold)" />

          {/* 书架 */}
          <rect x={118} y={28} width={40} height={3} fill="var(--pixel-wood-face)" />
          <rect x={118} y={31} width={40} height={1} fill="var(--pixel-ink)" opacity={0.4} />
          <rect x={122} y={16} width={4} height={12} fill="var(--pixel-rose)" />
          <rect x={128} y={14} width={5} height={14} fill="var(--pixel-blue)" />
          <rect x={135} y={18} width={3} height={10} fill="var(--pixel-gold)" />
          <rect x={140} y={21} width={9} height={7} fill="var(--pixel-wood-dark)" />
          <rect x={140} y={21} width={9} height={1} fill="var(--pixel-wood-top)" />

          {/* 台灯光锥（墙面） */}
          <polygon points="15,63 39,63 48,82 6,82" fill="var(--pixel-gold)" opacity={0.05} />
          <polygon points="20,63 35,63 40,82 15,82" fill="var(--pixel-gold)" opacity={0.06} />

          {/* 书桌 */}
          <rect x={4} y={82} width={152} height={1} fill="var(--pixel-wood-top)" />
          <rect x={4} y={83} width={152} height={3} fill="var(--pixel-wood-face)" />
          <rect x={4} y={86} width={152} height={10} fill="var(--pixel-wood-dark)" />
          <rect x={4} y={86} width={152} height={1} fill="var(--pixel-ink)" opacity={0.35} />
          <rect x={14} y={88} width={52} height={6} fill="var(--pixel-wood-face)" opacity={0.55} />
          <rect x={34} y={90} width={12} height={1} fill="var(--pixel-gold)" opacity={0.6} />
          <rect x={94} y={88} width={52} height={6} fill="var(--pixel-wood-face)" opacity={0.55} />
          <rect x={114} y={90} width={12} height={1} fill="var(--pixel-gold)" opacity={0.6} />
          <rect x={72} y={88} width={16} height={6} fill="var(--pixel-ink)" opacity={0.25} />

          {/* 桌面暖光池 + 屏幕冷光 */}
          <polygon points="18,83 44,83 40,85 22,85" fill="var(--pixel-gold)" opacity={0.16} />
          <rect x={92} y={83} width={36} height={3} fill="var(--pixel-iris)" opacity={0.06} />

          {/* 台灯 */}
          <rect x={21} y={78} width={14} height={4} fill="var(--pixel-wood-dark)" />
          <rect x={21} y={78} width={14} height={1} fill="var(--pixel-wood-top)" opacity={0.6} />
          <rect x={27} y={61} width={2} height={18} fill="var(--pixel-wood-dark)" />
          <rect x={27} y={61} width={1} height={18} fill="var(--pixel-wood-top)" opacity={0.45} />
          <polygon points="20,54 36,54 39,62 17,62" fill="var(--pixel-gold)" />
          <rect x={18} y={62} width={20} height={1} fill="var(--pixel-wood-dark)" />
          <rect x={27} y={62} width={2} height={2} fill="var(--pixel-glow)" />

          {/* 咖啡杯 */}
          <rect x={46} y={75} width={8} height={7} fill="var(--pixel-cream)" />
          <rect x={46} y={78} width={8} height={1} fill="var(--pixel-rose)" />
          <rect x={54} y={76} width={2} height={1} fill="var(--pixel-cream)" />
          <rect x={55} y={77} width={1} height={3} fill="var(--pixel-cream)" />
          <rect x={54} y={80} width={2} height={1} fill="var(--pixel-cream)" />
          <rect className="iris-pixel-steam" x={47} y={71} width={1} height={2} fill="var(--pixel-cream)" opacity={0} />
          <rect
            className="iris-pixel-steam"
            x={51}
            y={71}
            width={1}
            height={2}
            fill="var(--pixel-cream)"
            opacity={0}
            style={{ animationDelay: '-1.5s' }}
          />

          {/* 绿植（虎皮兰） */}
          <g fill="var(--pixel-mint-dark)">
            <rect x={65} y={62} width={3} height={13} />
            <rect x={65} y={60} width={2} height={2} />
            <rect x={65} y={57} width={1} height={3} />
            <rect x={73} y={64} width={3} height={11} />
            <rect x={74} y={61} width={2} height={3} />
            <rect x={75} y={59} width={1} height={2} />
          </g>
          <rect x={69} y={55} width={3} height={20} fill="var(--pixel-mint)" />
          <rect x={69} y={52} width={2} height={3} fill="var(--pixel-mint)" />
          <rect x={69} y={50} width={1} height={2} fill="var(--pixel-mint)" />
          <rect x={65} y={62} width={1} height={13} fill="var(--pixel-mint)" opacity={0.5} />
          <rect x={69} y={55} width={1} height={20} fill="var(--pixel-cream)" opacity={0.18} />
          <rect x={63} y={74} width={16} height={2} fill="var(--pixel-rose)" />
          <polygon points="64,76 78,76 75,82 67,82" fill="var(--pixel-rose)" />
          <rect x={63} y={74} width={16} height={1} fill="var(--pixel-glow)" opacity={0.3} />

          {/* 显示器 */}
          <rect x={84} y={42} width={50} height={38} fill="var(--pixel-bezel)" />
          <rect x={87} y={45} width={44} height={30} fill="var(--pixel-screen-bg)" />
          <rect x={87} y={45} width={44} height={4} fill="var(--pixel-titlebar)" />
          <rect x={89} y={46} width={1} height={1} fill="var(--pixel-rose)" />
          <rect x={92} y={46} width={1} height={1} fill="var(--pixel-gold)" />
          <rect x={95} y={46} width={1} height={1} fill="var(--pixel-mint)" />
          <rect x={87} y={49} width={24} height={26} fill="var(--pixel-pane-doc)" />
          <rect className="iris-pixel-line" x={90} y={53} width={14} height={2} fill="var(--pixel-iris)" />
          <rect
            className="iris-pixel-line"
            x={90}
            y={57}
            width={17}
            height={1}
            fill="var(--pixel-cream)"
            opacity={0.55}
            style={{ animationDelay: '0.3s' }}
          />
          <rect
            className="iris-pixel-line"
            x={90}
            y={60}
            width={14}
            height={1}
            fill="var(--pixel-cream)"
            opacity={0.55}
            style={{ animationDelay: '0.55s' }}
          />
          <rect
            className="iris-pixel-line"
            x={90}
            y={63}
            width={16}
            height={1}
            fill="var(--pixel-cream)"
            opacity={0.55}
            style={{ animationDelay: '0.8s' }}
          />
          <rect
            className="iris-pixel-line"
            x={90}
            y={66}
            width={10}
            height={1}
            fill="var(--pixel-cream)"
            opacity={0.55}
            style={{ animationDelay: '1.05s' }}
          />
          <g className="iris-pixel-stamp" style={{ animationDelay: '1.9s' }}>
            <rect x={104} y={58} width={5} height={5} fill="var(--pixel-gold)" />
            <g fill="var(--pixel-ink)">
              <rect x={104} y={59} width={1} height={1} />
              <rect x={104} y={60} width={1} height={1} />
              <rect x={105} y={61} width={1} height={1} />
              <rect x={106} y={60} width={1} height={1} />
              <rect x={107} y={59} width={1} height={1} />
            </g>
          </g>
          <g>
            <rect
              className="iris-pixel-char"
              x={90}
              y={69}
              width={4}
              height={2}
              fill="var(--pixel-mint)"
              style={{ animationDelay: '1.5s' }}
            />
            <rect
              className="iris-pixel-char"
              x={95}
              y={69}
              width={4}
              height={2}
              fill="var(--pixel-rose)"
              style={{ animationDelay: '1.7s' }}
            />
            <rect
              className="iris-pixel-char"
              x={100}
              y={69}
              width={6}
              height={2}
              fill="var(--pixel-gold)"
              style={{ animationDelay: '1.9s' }}
            />
          </g>
          <rect x={111} y={49} width={1} height={26} fill="var(--pixel-ink)" opacity={0.6} />
          <rect x={112} y={49} width={19} height={26} fill="var(--pixel-pane-term)" />
          <g fill="var(--pixel-gold)">
            <rect x={114} y={52} width={1} height={1} />
            <rect x={115} y={53} width={1} height={1} />
            <rect x={114} y={54} width={1} height={1} />
          </g>
          <g fill="var(--pixel-mint)">
            {PIXEL_TYPED_DELAYS.map((delay, index) => (
              <rect
                key={delay}
                className="iris-pixel-char"
                x={117 + index * 2}
                y={51}
                width={1}
                height={3}
                style={{ animationDelay: `${delay}s` }}
              />
            ))}
          </g>
          <rect className="iris-pixel-cursor" x={127} y={50} width={2} height={5} fill="var(--pixel-gold)" />
          <rect
            className="iris-pixel-line"
            x={114}
            y={58}
            width={13}
            height={1}
            fill="var(--pixel-mint)"
            opacity={0.7}
            style={{ animationDelay: '1.6s' }}
          />
          <rect
            className="iris-pixel-line"
            x={114}
            y={61}
            width={10}
            height={1}
            fill="var(--pixel-blue)"
            opacity={0.7}
            style={{ animationDelay: '1.8s' }}
          />
          <rect
            className="iris-pixel-line"
            x={114}
            y={64}
            width={12}
            height={1}
            fill="var(--pixel-cream)"
            opacity={0.45}
            style={{ animationDelay: '2s' }}
          />
          <rect x={104} y={78} width={6} height={2} fill="var(--pixel-bezel)" />
          <rect x={96} y={80} width={18} height={2} fill="var(--pixel-bezel)" />
          <rect x={96} y={80} width={18} height={1} fill="var(--pixel-body)" />

          {/* 右侧文档堆 */}
          <rect x={136} y={79} width={18} height={3} fill="var(--pixel-cream)" opacity={0.75} />
          <rect x={137} y={76} width={16} height={3} fill="var(--pixel-cream)" opacity={0.9} />
          <rect x={139} y={72} width={15} height={6} fill="var(--pixel-cream)" />
          <rect x={149} y={69} width={5} height={3} fill="var(--pixel-gold)" />
          <rect x={141} y={74} width={9} height={1} fill="var(--pixel-ink)" opacity={0.45} />
          <rect x={141} y={76} width={6} height={1} fill="var(--pixel-ink)" opacity={0.35} />
          <rect x={139} y={72} width={15} height={1} fill="var(--pixel-glow)" opacity={0.3} />

          {/* 前景地面 */}
          <rect x={0} y={96} width={160} height={14} fill="var(--pixel-floor)" />
          <rect x={4} y={96} width={152} height={2} fill="var(--pixel-ink)" opacity={0.5} />
        </g>
      </svg>
    </div>
  );
}

export function WelcomeView(): JSX.Element {
  const { t } = useTranslation();
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
              <span className="text-muted-foreground"> - {t('project.tagline')}</span>
            </h1>
          </header>

          <section className="mt-10" aria-labelledby="welcome-start-title">
            <h2 id="welcome-start-title" className="mb-2.5 text-lg font-medium text-foreground">
              {t('project.start')}
            </h2>
            <div className="flex flex-col items-start gap-0.5">
              <Button
                variant="ghost"
                className="h-8 justify-start px-1.5 font-normal text-primary hover:bg-primary/10 hover:text-primary"
                disabled={opening}
                onClick={() => void chooseFolder()}
              >
                {opening ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                {opening ? t('project.opening') : t('project.openFolder')}
              </Button>
              <Button
                variant="ghost"
                className="h-8 justify-start px-1.5 font-normal text-primary hover:bg-primary/10 hover:text-primary"
                disabled={opening}
                onClick={() => void chooseFolderInNewWindow()}
              >
                <AppWindow />
                {t('project.openNewWindow')}
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
              {t('project.recent')}
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
                {t('project.noRecent')}
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
                        aria-label={project.path}
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
                            <span className="shrink-0 text-[10px] text-destructive">{t('project.pathUnavailable')}</span>
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
                            aria-label={t('project.removeRecentNamed', { name: project.name })}
                            onClick={() => void removeRecent(project.path)}
                          >
                            {removing ? <Loader2 className="animate-spin" /> : <X />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('project.removeRecent')}</TooltipContent>
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
