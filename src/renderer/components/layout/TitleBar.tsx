/**
 * Top bar: app identity + theme switcher + pipeline debug button.
 * M0 placeholder — project name / workspace breadcrumbs arrive with M1.
 */
import { useState } from 'react';
import { Moon, Sun, MoonStar, Palette, Activity } from 'lucide-react';
import type { DeepPartial, PingResult, Settings, ThemeId } from '@shared/types';
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
    <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-card px-3">
      <span className="text-sm font-semibold tracking-wide text-primary">Iris</span>
      <ProjectCrumb />

      <div className="ml-auto flex items-center gap-1.5">
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
          <DropdownMenuContent align="end">
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
      </div>
    </div>
  );
}
