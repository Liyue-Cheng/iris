/**
 * Left pane: lens tree (default) / raw tree (escape hatch) + project-level
 * empty states. The pane header carries the open-project and raw-toggle
 * affordances.
 */
import { useState } from 'react';
import {
  FolderOpen,
  FolderPlus,
  ListChecks,
  ListTree,
  FolderTree,
  Loader2,
  TriangleAlert,
  ArrowDownAZ,
  Clock,
  Search,
  X,
} from 'lucide-react';
import { collectTodos } from '@renderer/lib/collect-docs';
import { cn } from '@renderer/lib/utils';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { projectStore, useProject } from '@renderer/stores/project-store';
import { lensPrefs, useLensPrefs } from '@renderer/stores/lens-prefs';
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
  const { phase, error, scan, rawMode, rawTree, view } = useProject();
  const { sort, filter, filterOpen } = useLensPrefs();
  const [initOpen, setInitOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);

  const todoCount =
    phase === 'ready' && scan?.root ? collectTodos(scan.root, null).length : 0;

  const constitutionMissing = phase === 'ready' && !!scan?.hasIris && !scan.constitution.exists;
  const protocolMismatch =
    phase === 'ready' &&
    !!scan?.constitution.exists &&
    scan.constitution.protocol !== PROTOCOL_VERSION;

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
          {phase === 'ready' && scan?.hasIris && (
            <>
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
                    className="h-7 w-7"
                    onClick={() => setWsOpen(true)}
                  >
                    <FolderPlus className="!size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>新建工作区（人的手势）</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => void projectStore.toggleRawMode()}
                  >
                    {rawMode ? (
                      <ListTree className="!size-4" />
                    ) : (
                      <FolderTree className="!size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{rawMode ? '切回透镜树' : '裸文件树（逃生舱）'}</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {phase === 'ready' && scan?.hasIris && filterOpen && (
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
