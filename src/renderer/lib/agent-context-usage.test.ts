import { describe, expect, it } from 'vitest';
import type { IrisAgentContextBudget, IrisAgentContextUsage } from '@shared/types';
import {
  CONTEXT_RING_CIRCUMFERENCE,
  contextBudgetTitle,
  contextRingOffset,
  contextTriggerAngle,
  contextUsageLabel,
  contextUsagePercent,
  contextUsageTitle,
  contextUsageTone,
  formatTokenCount,
} from '@renderer/lib/agent-context-usage';

const budget: IrisAgentContextBudget = { windowTokens: 1_000_000, triggerTokens: 983_616 };

function usage(overrides: Partial<IrisAgentContextUsage> = {}): IrisAgentContextUsage {
  return { usedTokens: 372_000, measurement: 'reported', updatedAt: 1, ...overrides };
}

describe('agent context usage presentation', () => {
  it('labels window sizes compactly', () => {
    expect(formatTokenCount(128_000)).toBe('128K');
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
    expect(formatTokenCount(0)).toBe('0');
  });

  it('shows the strict percentage instead of a clamped one', () => {
    expect(contextUsagePercent(usage(), budget)).toBe(37);
    expect(contextUsageLabel(usage(), budget)).toBe('37%');
    // Past the window the number keeps telling the truth.
    expect(contextUsagePercent(usage({ usedTokens: 1_200_000 }), budget)).toBe(120);
    expect(contextUsageLabel(usage({ usedTokens: 1_200_000 }), budget)).toBe('120%');
  });

  it('saturates the arc at one full turn while the number keeps growing', () => {
    expect(contextRingOffset(usage(), budget)).toBeCloseTo(CONTEXT_RING_CIRCUMFERENCE * 0.628, 6);
    expect(contextRingOffset(usage({ usedTokens: 1_000_000 }), budget)).toBe(0);
    expect(contextRingOffset(usage({ usedTokens: 3_000_000 }), budget)).toBe(0);
    // Never longer than the ring, never negative.
    expect(contextRingOffset(usage(), budget)).toBeLessThanOrEqual(CONTEXT_RING_CIRCUMFERENCE);
    expect(contextRingOffset(usage({ usedTokens: 0 }), budget)).toBe(CONTEXT_RING_CIRCUMFERENCE);
  });

  it('places the trigger tick by its true share of the window', () => {
    expect(contextTriggerAngle(budget)).toBeCloseTo(354.1, 1);
    expect(contextTriggerAngle({ windowTokens: 1_000, triggerTokens: 500 })).toBe(180);
    expect(contextTriggerAngle({ windowTokens: 1_000, triggerTokens: 2_000 })).toBe(360);
  });

  it('grades by the compaction trigger without touching the number', () => {
    expect(contextUsageTone(usage(), budget)).toBe('normal');
    expect(contextUsageTone(usage({ usedTokens: 800_000 }), budget)).toBe('warning');
    expect(contextUsageTone(usage({ usedTokens: 983_616 }), budget)).toBe('danger');
    expect(contextUsageTone(usage({ usedTokens: 1_000_000 }), budget)).toBe('danger');
    expect(contextUsageTone(usage({ usedTokens: 1_000_001 }), budget)).toBe('danger');
  });

  it('keeps the absolute numbers in the hover detail', () => {
    // The label names the measured object, and the source names its time point:
    // both readings describe the prompt side of a request.
    expect(contextUsageTitle(usage(), budget))
      .toContain('已用（prompt 侧） 372,000 / 1,000,000 tokens');
    expect(contextUsageTitle(usage(), budget)).toContain('来源：provider 上报（上次请求输入）');
    expect(contextUsageTitle(usage({ measurement: 'estimated' }), budget))
      .toContain('来源：本地估算（下次请求）');
    expect(contextBudgetTitle(budget)).toContain('整理水位 983,616');
    expect(contextBudgetTitle(budget)).toContain('尚无读数');
  });
});
