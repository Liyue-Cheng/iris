/**
 * Left pane: lens tree (default) / raw tree (escape hatch) + project-level
 * empty states. The pane header carries the open-project and raw-toggle
 * affordances.
 */
import { useState } from 'react';
import { FolderOpen, FolderPlus, ListTree, FolderTree, Loader2, TriangleAlert } from 'lucide-react';
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
import { InitDialog } from '@renderer/components/project/InitDialog';
import { CreateWorkspaceDialog } from '@renderer/components/project/CreateWorkspaceDialog';
import { PROTOCOL_VERSION } from '@shared/protocol-version';

function EmptyState({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export function LeftPane(): JSX.Element {
  const { phase, error, scan, rawMode, rawTree } = useProject();
  const [initOpen, setInitOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);

  const constitutionMissing = phase === 'ready' && !!scan?.hasIris && !scan.constitution.exists;
  const protocolMismatch =
    phase === 'ready' &&
    !!scan?.constitution.exists &&
    scan.constitution.protocol !== PROTOCOL_VERSION;

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
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setWsOpen(true)}
                  >
                    <FolderPlus className="!size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>新建工作区（人的手势）</TooltipContent>
              </Tooltip>
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
            </>
          )}
        </div>
      </div>

      {constitutionMissing && (
        <button
          type="button"
          onClick={() => setInitOpen(true)}
          className="flex shrink-0 items-start gap-1.5 border-b bg-[var(--rp-gold)]/10 px-2 py-1.5 text-left text-[11px] text-[var(--rp-gold)] hover:bg-[var(--rp-gold)]/20"
        >
          <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
          缺少 .iris/CONVENTIONS.md —— agent 读不到宪法。点击补全。
        </button>
      )}
      {protocolMismatch && (
        <div className="flex shrink-0 items-start gap-1.5 border-b bg-[var(--rp-gold)]/10 px-2 py-1.5 text-[11px] text-[var(--rp-gold)]">
          <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
          宪法 protocol={scan?.constitution.protocol ?? '缺失'}，本应用支持 {PROTOCOL_VERSION}。
          宪法归你所有，应用不代改——请人工核对差异后更新。
        </div>
      )}

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

      <InitDialog
        open={initOpen}
        onClose={() => setInitOpen(false)}
        missingConstitutionOnly={constitutionMissing}
      />
      <CreateWorkspaceDialog open={wsOpen} onClose={() => setWsOpen(false)} />
    </div>
  );
}
