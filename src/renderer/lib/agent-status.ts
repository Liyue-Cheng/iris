/**
 * Single source for how Agent work reads: the task status vocabulary, the
 * terminal outcome vocabulary, and the badge tone that goes with each.
 *
 * Three places used to spell these strings out independently (the background
 * task card, the header's terminal menu, and the terminal dialog badge), so a
 * new status could appear in one and silently render as the default in another.
 */
import type { IrisAgentTaskStatus, IrisAgentTerminalView } from '@shared/types';

export type AgentStatusTone = 'running' | 'success' | 'failure' | 'neutral';

/** `queued`/`starting`/`running` are the statuses that still have a live PTY. */
export function isActiveTaskStatus(status: IrisAgentTaskStatus): boolean {
  return status === 'queued' || status === 'starting' || status === 'running';
}

export function taskStatusLabel(status: IrisAgentTaskStatus): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'starting':
      return '启动中';
    case 'running':
      return '运行中';
    case 'succeeded':
      return '已完成';
    case 'failed':
      return '失败';
    case 'canceled':
      return '已取消';
    case 'lost':
      return '已丢失';
  }
}

export function taskStatusTone(status: IrisAgentTaskStatus): AgentStatusTone {
  if (isActiveTaskStatus(status)) return 'running';
  if (status === 'succeeded') return 'success';
  if (status === 'failed' || status === 'lost') return 'failure';
  return 'neutral';
}

/** Terminal work only reports an exit code once it actually exited. */
export function terminalStatusLabel(terminal: IrisAgentTerminalView): string {
  if (terminal.state === 'running') return '运行中';
  if (terminal.outcome === 'timeout') return '已超时';
  if (terminal.outcome === 'canceled') return '已取消';
  if (terminal.outcome === 'launch-failed') return '启动失败';
  if (terminal.exitCode === undefined || terminal.exitCode === null) return '已结束';
  return `退出码 ${terminal.exitCode}`;
}

export function terminalStatusTone(terminal: IrisAgentTerminalView): AgentStatusTone {
  if (terminal.state === 'running') return 'running';
  if (terminal.outcome === 'timeout' || terminal.outcome === 'launch-failed') return 'failure';
  if (terminal.outcome === 'canceled') return 'neutral';
  if (terminal.exitCode === undefined || terminal.exitCode === null) return 'neutral';
  return terminal.exitCode === 0 ? 'success' : 'failure';
}

export function statusBadgeClass(tone: AgentStatusTone): string {
  switch (tone) {
    case 'running':
    case 'success':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
    case 'failure':
      return 'border-destructive/30 bg-destructive/10 text-destructive';
    case 'neutral':
      return 'border-border bg-muted/60 text-muted-foreground';
  }
}

/** Compact status dot for menu rows, where a full badge would be too loud. */
export function statusDotClass(tone: AgentStatusTone): string {
  switch (tone) {
    case 'running':
    case 'success':
      return 'bg-emerald-500';
    case 'failure':
      return 'bg-destructive';
    case 'neutral':
      return 'bg-muted-foreground';
  }
}
