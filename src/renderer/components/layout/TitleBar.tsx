/**
 * Top bar: app identity + theme switcher + pipeline debug button. Doubles as
 * the frameless window's drag region (frame:false) and hosts the Windows
 * caption buttons; window verbs go through the window:* UI-helper channels.
 */
import { useEffect, useState } from 'react';
import { Moon, Sun, MoonStar, Palette, Activity, Minus, Square, Copy, X, Cog } from 'lucide-react';
import type { DeepPartial, PingResult, Settings, ThemeId } from '@shared/types';
import { CHANNELS, EVENTS } from '@shared/protocol';
import { cn } from '@renderer/lib/utils';
import { openSettingsView } from '@renderer/components/settings/SettingsView';
import { IrisMark } from '@renderer/components/layout/IrisMark';
import { pipeline } from '@renderer/cpu';
import { useSettings } from '@renderer/stores/settings-store';
import { useProject } from '@renderer/stores/project-store';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';

const THEME_LABELS: Record<ThemeId, { label: string; icon: typeof Moon }> = {
  'rose-pine': { label: 'Rosé Pine', icon: Moon },
  'rose-pine-dawn': { label: 'Rosé Pine Dawn', icon: Sun },
  'rose-pine-moon': { label: 'Rosé Pine Moon', icon: MoonStar },
  cutie: { label: 'Cutie', icon: Sun },
  business: { label: 'Business', icon: Moon },
  ubuntu: { label: 'Ubuntu', icon: Moon },
  'windows-terminal': { label: 'Windows Terminal', icon: Moon },
  'one-dark-pro': { label: 'One Dark Pro', icon: Moon },
  dracula: { label: 'Dracula', icon: Moon },
  'tokyo-night': { label: 'Tokyo Night', icon: Moon },
  'catppuccin-mocha': { label: 'Catppuccin Mocha', icon: Moon },
  'catppuccin-latte': { label: 'Catppuccin Latte', icon: Sun },
  'tokyo-night-day': { label: 'Tokyo Night Day', icon: Sun },
  'light-pink': { label: 'Light Pink', icon: Sun },
  fairyfloss: { label: 'Fairyfloss', icon: Moon },
};

function ProjectCrumb(): JSX.Element | null {
  const { phase, scan } = useProject();
  if (phase !== 'ready' || !scan) return null;
  return (
    <span className="truncate text-xs text-muted-foreground" title={scan.projectRoot}>
      — {scan.projectRoot}
    </span>
  );
}

/** Windows-layout caption buttons (minimize / maximize-restore / close). */
function WindowControls(): JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.api
      .invoke<undefined, boolean>(CHANNELS.WINDOW_IS_MAXIMIZED)
      .then(setMaximized);
    return window.api.on<{ maximized: boolean }>(EVENTS.WINDOW_MAXIMIZED_CHANGED, (e) =>
      setMaximized(e.maximized),
    );
  }, []);

  const caption =
    'flex h-10 w-11 items-center justify-center text-muted-foreground hover:text-foreground';

  return (
    <div className="app-region-no-drag ml-1 flex shrink-0 self-start">
      <button
        type="button"
        title="最小化"
        className={cn(caption, 'hover:bg-muted')}
        onClick={() => void window.api.invoke(CHANNELS.WINDOW_MINIMIZE)}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title={maximized ? '还原' : '最大化'}
        className={cn(caption, 'hover:bg-muted')}
        onClick={() => void window.api.invoke(CHANNELS.WINDOW_MAXIMIZE_TOGGLE)}
      >
        {maximized ? (
          <Copy className="h-3 w-3 -scale-x-100" />
        ) : (
          <Square className="h-3 w-3" />
        )}
      </button>
      <button
        type="button"
        title="关闭"
        className={cn(caption, 'hover:bg-[var(--rp-love)] hover:text-[var(--rp-base)]')}
        onClick={() => void window.api.invoke(CHANNELS.WINDOW_CLOSE)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function TitleBar(): JSX.Element {
  const settings = useSettings();
  const [pingState, setPingState] = useState<string | null>(null);

  const theme = settings?.appearance.theme ?? 'rose-pine';

  function switchTheme(next: string): void {
    // Side effect → instruction. The store updates when the main process
    // broadcasts evt:settings:changed; nothing is mutated locally.
    const partial: DeepPartial<Settings> = { appearance: { theme: next as ThemeId } };
    void pipeline.dispatch('settings.update', partial);
  }

  async function ping(): Promise<void> {
    setPingState('…');
    try {
      const result = (await pipeline.dispatch('app.ping', {
        from: 'renderer',
        sentAt: new Date().toISOString(),
      })) as PingResult;
      setPingState(`pong ← main pid ${result.pid} @ ${result.time.slice(11, 19)}`);
    } catch (err) {
      setPingState(`failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="app-region-drag flex h-10 shrink-0 items-center gap-2 bg-card pl-3">
      <IrisMark className="h-4 w-4 shrink-0" />
      <span className="text-sm font-semibold tracking-wide text-primary">Iris</span>
      <ProjectCrumb />

      <div className="app-region-no-drag ml-auto flex items-center gap-1.5">
        {pingState && (
          <span className="text-xs text-muted-foreground" data-testid="ping-result">
            {pingState}
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={() => void ping()}>
              <Activity />
            </Button>
          </TooltipTrigger>
          <TooltipContent>app.ping — 流水线 → IPC → 主进程往返</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon">
                  <Palette />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>主题</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="max-h-[70vh] overflow-y-auto">
            <DropdownMenuRadioGroup value={theme} onValueChange={switchTheme}>
              {(Object.keys(THEME_LABELS) as ThemeId[]).map((id) => {
                const { label, icon: Icon } = THEME_LABELS[id];
                return (
                  <DropdownMenuRadioItem key={id} value={id}>
                    <Icon className="mr-2 h-4 w-4" />
                    {label}
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={openSettingsView}>
              <Cog />
            </Button>
          </TooltipTrigger>
          <TooltipContent>设置</TooltipContent>
        </Tooltip>
      </div>

      <WindowControls />
    </div>
  );
}
