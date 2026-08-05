import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, ChevronsUpDown, GitBranch, RefreshCw, Undo2, Plus } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { cn } from '@renderer/lib/utils';
import { gitStore, useGit, type GitResource, type GitResourceGroup } from '@renderer/stores/git-store';
import type { GitSnapshot } from '@shared/types';
import { useProject } from '@renderer/stores/project-store';

const labels: Record<GitResourceGroup, string> = { merge: 'Merge Changes', index: 'Staged Changes', workingTree: 'Changes', untracked: 'Untracked Changes' };

function BranchSwitcher({ snapshot, pending }: { snapshot: GitSnapshot; pending: boolean }): JSX.Element {
  const branchLabel = snapshot.branch ?? (snapshot.detached ? 'HEAD' : 'Git');
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        disabled={pending || snapshot.branches.length === 0}
        variant="ghost"
        size="sm"
        className="h-7 min-w-0 flex-1 justify-start gap-1 px-1 text-xs font-semibold"
        title="切换 Git 分支"
      >
        <GitBranch className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{branchLabel}</span>
        <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="max-h-72 max-w-[min(18rem,calc(100vw-2rem))] overflow-y-auto">
      <DropdownMenuLabel className="text-[11px] text-muted-foreground">本地分支</DropdownMenuLabel>
      {snapshot.branches.map((branch) => (
        <DropdownMenuItem
          key={branch.name}
          disabled={pending || branch.current}
          onSelect={() => void gitStore.switchBranch(branch.name)}
          className="justify-between gap-4"
        >
          <span className="min-w-0 truncate" title={branch.name}>{branch.name}</span>
          {branch.current && <Check className="size-3.5 shrink-0" />}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function Group({ kind, resources, pending }: { kind: GitResourceGroup; resources: GitResource[]; pending: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(true);
  if (resources.length === 0) return null;
  const staged = kind === 'index';
  return <div className="shrink-0 border-b border-border/50">
    <button type="button" className="flex h-7 w-full items-center gap-1 px-2 text-left text-[11px] font-semibold hover:bg-accent/40" onClick={() => setOpen(!open)}>
      {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}<span className="flex-1">{labels[kind]}</span><span className="text-muted-foreground">{resources.length}</span>
      <span role="group" className="ml-1 flex gap-0.5">{staged ? <Button disabled={pending} variant="ghost" size="icon" className="h-5 w-5" title="全部取消暂存" onClick={(e) => { e.stopPropagation(); void gitStore.unstage(resources.map((r) => r.path)); }}><Undo2 /></Button> : <Button disabled={pending} variant="ghost" size="icon" className="h-5 w-5" title="全部暂存" onClick={(e) => { e.stopPropagation(); void gitStore.stage(resources.map((r) => r.path)); }}><Plus /></Button>}</span>
    </button>
    {open && resources.map((r) => <div key={`${kind}:${r.path}`} className="group flex h-7 items-center gap-1 px-3 text-xs hover:bg-accent/40"><span className="w-4 font-mono text-[10px] text-muted-foreground">{r.status}</span><span className="min-w-0 flex-1 truncate" title={r.path}>{r.path}</span><Button disabled={pending} variant="ghost" size="icon" className="h-5 w-5 opacity-0 group-hover:opacity-100" title={staged ? '取消暂存' : '暂存'} onClick={() => void (staged ? gitStore.unstage([r.path]) : gitStore.stage([r.path]))}>{staged ? <Undo2 /> : <Plus />}</Button></div>)}
  </div>;
}

export function SourceControlPanel({
  mode = 'panel',
  refreshOnReady = true,
}: {
  mode?: 'panel' | 'view';
  refreshOnReady?: boolean;
}): JSX.Element | null {
  const { phase } = useProject();
  const { snapshot, loading, pending, error } = useGit();
  const [open, setOpen] = useState(true);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (refreshOnReady && phase === 'ready' && !snapshot) void gitStore.refresh();
  }, [phase, refreshOnReady, snapshot]);
  const count = useMemo(() => snapshot ? Object.values(snapshot.groups).reduce((n, g) => n + g.length, 0) : 0, [snapshot]);
  if (phase !== 'ready') return null;
  return <div className={cn(
    'flex min-h-8 shrink-0 flex-col',
    mode === 'panel' ? 'max-h-[46%] border-t border-border' : 'h-full max-h-none min-h-0 min-w-0',
  )}>
    <div className="flex h-8 items-center gap-1 px-2">
      <button type="button" aria-label={open ? '折叠 Git 面板' : '展开 Git 面板'} className="flex h-7 w-4 shrink-0 items-center justify-center text-left text-xs font-semibold" onClick={() => setOpen(!open)}>{open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}</button>
      {snapshot?.available ? <BranchSwitcher snapshot={snapshot} pending={!!pending} /> : <div className="flex min-w-0 flex-1 items-center gap-1 text-xs font-semibold"><GitBranch className="size-3.5 shrink-0" /><span className="truncate">{snapshot?.branch ?? (snapshot?.detached ? 'HEAD' : 'Git')}</span></div>}
      {count > 0 && <span className="text-muted-foreground">{count}</span>}
      <Button disabled={loading || !!pending} variant="ghost" size="icon" className="h-6 w-6" title="刷新 Git 状态" onClick={() => void gitStore.refresh()}><RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /></Button>
    </div>
    {open && <div className="min-h-0 flex-1 overflow-y-auto">
      {loading && !snapshot && <div className="px-3 py-2 text-[11px] text-muted-foreground">正在读取 Git 状态…</div>}
      {!loading && !snapshot?.available && <div className="px-3 py-2 text-[11px] text-muted-foreground">{snapshot?.error ?? error ?? '不是 Git 仓库'}</div>}
      {snapshot?.available && <><div className="flex gap-1 border-b border-border/50 p-2"><input value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { void gitStore.commit(message); setMessage(''); } }} placeholder="提交信息" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60" /><Button disabled={!message.trim() || !!pending || snapshot.groups.index.length === 0} variant="ghost" size="icon" className="h-6 w-6" title="提交暂存内容" onClick={() => { void gitStore.commit(message); setMessage(''); }}><Check /></Button></div>{(['merge', 'index', 'workingTree', 'untracked'] as GitResourceGroup[]).map((kind) => <Group key={kind} kind={kind} resources={snapshot.groups[kind]} pending={!!pending} />)}</>}
      {(error || snapshot?.error) && <div className="px-3 py-1 text-[11px] text-destructive">{error ?? snapshot?.error}</div>}
    </div>}
  </div>;
}
