import type { IrisAgentContextBudget, IrisAgentContextUsage } from '@shared/types';

/**
 * Presentation-only projection of the Session's context reading. The numbers
 * themselves are owned by main (provider counters, or the same request estimate
 * the compaction trigger uses), so this module never recomputes occupancy — it
 * only decides how strictly-measured values are drawn.
 *
 * Every reading describes the same object, the prompt side of one request: tool
 * schemas + method layers + history. `reported` is the provider's own counter
 * for the request it just answered; `estimated` is that projection for the
 * request about to be sent.
 */
export type ContextUsageTone = 'normal' | 'warning' | 'danger';

/** Ring geometry, shared by the SVG and its pure-function tests. */
export const CONTEXT_RING_SIZE = 20;
export const CONTEXT_RING_RADIUS = 9;
export const CONTEXT_RING_STROKE = 2;
export const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;

/** Compact token label: `1M`, `128K`, `1.5M`. */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : Number(millions.toFixed(1))}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/**
 * The exact share of the window that is occupied. It is deliberately not
 * clamped: past 100% the reading is still the true number, and the runtime has
 * a real response to it (compaction, or an overflow retry).
 */
export function contextUsagePercent(usage: IrisAgentContextUsage, budget: IrisAgentContextBudget): number {
  if (!Number.isFinite(budget.windowTokens) || budget.windowTokens <= 0) return 0;
  return Math.round((usage.usedTokens / budget.windowTokens) * 100);
}

/** The number shown beside the ring: the strict percentage. */
export function contextUsageLabel(usage: IrisAgentContextUsage, budget: IrisAgentContextBudget): string {
  return `${contextUsagePercent(usage, budget)}%`;
}

/**
 * Arc length still to be drawn. Only the drawing saturates at a full circle —
 * a ring cannot exceed one turn — while the number may go past 100%.
 */
export function contextRingOffset(usage: IrisAgentContextUsage, budget: IrisAgentContextBudget): number {
  const ratio = budget.windowTokens > 0 ? usage.usedTokens / budget.windowTokens : 0;
  return CONTEXT_RING_CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, ratio)));
}

/** Angle of the compaction trigger, in degrees clockwise from 12 o'clock. */
export function contextTriggerAngle(budget: IrisAgentContextBudget): number {
  if (!Number.isFinite(budget.windowTokens) || budget.windowTokens <= 0) return 0;
  return Math.min(360, Math.max(0, (budget.triggerTokens / budget.windowTokens) * 360));
}

/**
 * The compaction trigger is the line that makes the runtime act; the window is
 * only a hard ceiling. Colour only ever annotates the strict number, so it
 * cannot make the reading look different from what it is.
 */
export function contextUsageTone(usage: IrisAgentContextUsage, budget: IrisAgentContextBudget): ContextUsageTone {
  if (usage.usedTokens >= budget.windowTokens) return 'danger';
  if (budget.triggerTokens <= 0) return 'normal';
  const triggerRatio = usage.usedTokens / budget.triggerTokens;
  if (triggerRatio >= 1) return 'danger';
  if (triggerRatio >= 0.8) return 'warning';
  return 'normal';
}

/** Hover detail: the absolute numbers, which the ring and percentage cannot carry. */
export function contextUsageTitle(usage: IrisAgentContextUsage, budget: IrisAgentContextBudget): string {
  // The source label names both the measurement and its time point, because the
  // two sources describe the same object from different moments.
  const source = usage.measurement === 'reported'
    ? 'provider 上报（上次请求输入）'
    : '本地估算（下次请求）';
  return [
    `已用（prompt 侧） ${usage.usedTokens.toLocaleString()} / ${budget.windowTokens.toLocaleString()} tokens`,
    `（${contextUsagePercent(usage, budget)}%）`,
    `，整理水位 ${budget.triggerTokens.toLocaleString()}`,
    `，来源：${source}`,
  ].join('');
}

/** Shown while the Session has a window but no reading yet. */
export function contextBudgetTitle(budget: IrisAgentContextBudget): string {
  return [
    `上下文窗口 ${budget.windowTokens.toLocaleString()} tokens`,
    `，整理水位 ${budget.triggerTokens.toLocaleString()} tokens`,
    '，尚无读数',
  ].join('');
}
