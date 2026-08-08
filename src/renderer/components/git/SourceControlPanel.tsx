import { useEffect, useMemo, useState } from 'react';
import { GitBranch, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { PANEL_BAR } from '@renderer/components/collection/parts/layout';
import { gitStore, useGit, type GitResourceGroup } from '@renderer/stores/git-store';
import { useProject } from '@renderer/stores/project-store';
import { BranchSwitcher } from './BranchSwitcher';
import { CommitBox } from './CommitBox';
import { ResourceGroup } from './ResourceGroup';

const GROUP_ORDER: GitResourceGroup[] = ['merge', 'index', 'workingTree', 'untracked'];

export function SourceControlPanel({
  mode = 'panel',
  refreshOnReady = true,
}: {
  mode?: 'panel' | 'view';
  refreshOnReady?: boolean;
}): JSX.Element | null {
  const { phase } = useProject();
  const { snapshot, loading, pending, error } = useGit();
  const [collapsed, setCollapsed] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (refreshOnReady && phase === 'ready' && !snapshot) void gitStore.refresh();
  }, [phase, refreshOnReady, snapshot]);

  const totalCount = useMemo(
    () =>
      snapshot
        ? Object.values(snapshot.groups).reduce((n, g) => n + g.length, 0)
        : 0,
    [snapshot],
  );
  const stagedCount = snapshot?.groups.index.length ?? 0;

  const handleCommit = (): void => {
    if (!message.trim() || stagedCount === 0) return;
    const msg = message;
    setMessage('');
    void gitStore.commit(msg);
  };

  if (phase !== 'ready') return null;

  const isView = mode === 'view';

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col',
        isView
          ? 'h-full min-h-0 min-w-0'
          : 'max-h-[46%] min-h-8 border-t border-border',
      )}
    >
      {/* ── Toolbar ── */}
      {isView ? (
        <div className={PANEL_BAR}>
          <h2 className="shrink-0 text-sm font-semibold">Source Control</h2>
          {snapshot?.available && (
            <BranchSwitcher snapshot={snapshot} pending={!!pending} />
          )}
          {!snapshot?.available && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GitBranch className="size-3.5" />
              {snapshot?.branch ?? 'Git'}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {totalCount > 0 && (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {totalCount}
              </span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  disabled={loading || !!pending}
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => void gitStore.refresh()}
                >
                  <RefreshCw
                    className={cn('!size-3.5', loading && 'animate-spin')}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">刷新</TooltipContent>
            </Tooltip>
          </div>
        </div>
      ) : (
        <div className="flex h-9 shrink-0 items-center gap-1 px-2">
          <button
            type="button"
            aria-label={collapsed ? '展开 Git 面板' : '折叠 Git 面板'}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? (
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            )}
          </button>
          {snapshot?.available ? (
            <BranchSwitcher snapshot={snapshot} pending={!!pending} />
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate">
                {snapshot?.branch ?? (snapshot?.detached ? 'HEAD' : 'Git')}
              </span>
            </span>
          )}
          {totalCount > 0 && (
            <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {totalCount}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                disabled={loading || !!pending}
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => void gitStore.refresh()}
              >
                <RefreshCw
                  className={cn('!size-3.5', loading && 'animate-spin')}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">刷新</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* ── Body ── */}
      {(isView || !collapsed) && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Loading */}
          {loading && !snapshot && (
            <div className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在读取 Git 状态…
            </div>
          )}

          {/* Not a git repo */}
          {!loading && !snapshot?.available && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {snapshot?.error ?? error ?? '不是 Git 仓库'}
            </div>
          )}

          {/* Available */}
          {snapshot?.available && (
            <>
              <CommitBox
                message={message}
                onMessageChange={setMessage}
                onCommit={handleCommit}
                stagedCount={stagedCount}
                pending={!!pending}
              />

              {totalCount > 0 ? (
                GROUP_ORDER.map((kind) => (
                  <ResourceGroup
                    key={kind}
                    kind={kind}
                    resources={snapshot.groups[kind]}
                    pending={!!pending}
                  />
                ))
              ) : (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  工作区干净，没有待提交的更改
                </div>
              )}
            </>
          )}

          {/* Error bar */}
          {(error || snapshot?.error) && snapshot?.available && (
            <div className="border-t border-subtle px-3 py-2 text-[11px] text-destructive">
              {error ?? snapshot.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
