/**
 * Left pane: lens tree (default) / raw tree (escape hatch) + project-level
 * empty states. The pane header carries the open-project and raw-toggle
 * affordances.
 */
import { FolderOpen, ListTree, FolderTree, Loader2 } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { projectStore, useProject } from '@renderer/stores/project-store';
import { pickAndOpenProject } from '@renderer/lib/project-actions';
import { LensTree } from '@renderer/components/lens/LensTree';
import { RawTree } from '@renderer/components/lens/RawTree';

function EmptyState({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function LeftPane(): JSX.Element {
  const { phase, error, scan, rawMode, rawTree } = useProject();

  return (
    <div className="flex h-full flex-col bg-card/50">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <span className="truncate text-xs font-medium text-muted-foreground">
          {scan?.projectName ?? '未打开项目'}
        </span>
        <div className="ml-auto flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => void pickAndOpenProject()}
              >
                <FolderOpen className="!size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>打开项目文件夹</TooltipContent>
          </Tooltip>
          {phase === 'ready' && scan?.hasIris && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => void projectStore.toggleRawMode()}
                >
                  {rawMode ? (
                    <ListTree className="!size-3.5" />
                  ) : (
                    <FolderTree className="!size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{rawMode ? '切回透镜树' : '裸文件树（逃生舱）'}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

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
            <p className="max-w-48 text-muted-foreground/70">
              初始化向导在 M5 提供；当前可手建 .iris/ 与类型文件夹，文件一落盘这里就会亮起来。
            </p>
          </EmptyState>
        )}

        {phase === 'ready' && scan?.hasIris && scan.root && (
          rawMode ? (
            rawTree ? (
              <RawTree root={rawTree} />
            ) : (
              <EmptyState>
                <Loader2 className="h-4 w-4 animate-spin" />
              </EmptyState>
            )
          ) : (
            <LensTree root={scan.root} />
          )
        )}
      </div>
    </div>
  );
}
