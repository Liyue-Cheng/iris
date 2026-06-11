/**
 * Top bar: app identity + theme switcher + pipeline debug button.
 * M0 placeholder — project name / workspace breadcrumbs arrive with M1.
 */
import { useState } from 'react';
import { Moon, Sun, MoonStar, Palette, Activity, Settings2 } from 'lucide-react';
import type { DeepPartial, PingResult, Settings, ThemeId } from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { pipeline } from '@renderer/cpu';
import { useSettings } from '@renderer/stores/settings-store';
import { useProject } from '@renderer/stores/project-store';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

/**
 * Machine-layer menu (~/.iris/CONVENTIONS.md, 附录 C): install the template
 * once, locate it for hand-editing afterwards. The app writes the template
 * and never reads the file again — it's the agent's, not the App's.
 */
function MachineLayerMenu(): JSX.Element {
  const [state, setState] = useState<{ exists: boolean; path: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    const s = await window.api.invoke<undefined, { exists: boolean; path: string }>(
      CHANNELS.MACHINE_CONVENTIONS_STATE,
    );
    setState(s);
  };

  const install = async (): Promise<void> => {
    try {
      const r = (await pipeline.dispatch('machine.install-conventions', {})) as { path: string };
      setMessage(`模板已写入 ${r.path}（请按本机实情填空）`);
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const reveal = (): void => {
    if (state?.path) void window.api.invoke(CHANNELS.SHELL_REVEAL, { path: state.path });
  };

  return (
    <DropdownMenu onOpenChange={(open) => open && void refresh()}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <Settings2 />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>机器层（~/.iris/）</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="max-w-72">
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          机器层宪法：本机事实清单（代理、加密软件、资源限制），agent 读、不进 git。
        </div>
        {state?.exists ? (
          <DropdownMenuItem onClick={reveal}>在资源管理器中定位（手工编辑）</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => void install()}>
            安装 ~/.iris/CONVENTIONS.md 模板
          </DropdownMenuItem>
        )}
        {message && <div className="max-w-64 px-2 py-1.5 text-[11px] text-muted-foreground">{message}</div>}
      </DropdownMenuContent>
    </DropdownMenu>
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

        <MachineLayerMenu />
      </div>
    </div>
  );
}
