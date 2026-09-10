import { describe, expect, it } from 'vitest';
import {
  agentContextBudgetForModel,
  agentContextTriggerTokens,
  DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_AGENT_RESERVE_OUTPUT_TOKENS,
} from './agent-context-budget';

describe('agent context budget', () => {
  it('reserves output headroom unless a trigger overrides it', () => {
    expect(agentContextTriggerTokens({ contextWindow: 100_000, reserveTokens: 20_000 })).toBe(80_000);
    expect(agentContextTriggerTokens({
      contextWindow: 100_000,
      reserveTokens: 20_000,
      triggerTokens: 70_000,
    })).toBe(70_000);
    // An explicit trigger still cannot leave the window or collapse to zero.
    expect(agentContextTriggerTokens({ contextWindow: 1_000, triggerTokens: 5_000 })).toBe(999);
    expect(agentContextTriggerTokens({ contextWindow: 1_000, triggerTokens: 0 })).toBe(1);
  });

  it('falls back to the shared defaults without configuration', () => {
    expect(agentContextTriggerTokens()).toBe(
      DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS - DEFAULT_AGENT_RESERVE_OUTPUT_TOKENS,
    );
    expect(agentContextTriggerTokens({ contextWindow: 4_000 })).toBe(1);
  });

  it('projects a catalog model into the window the indicator draws', () => {
    // The shape main resolves: window from the model, headroom from its policy.
    expect(agentContextBudgetForModel({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 32_000,
      contextPolicy: { reserveOutputTokens: 16_384, keepRecentTokens: 20_000, compactTrigger: 983_616 },
    })).toEqual({ windowTokens: 1_000_000, triggerTokens: 983_616 });

    // Without a policy trigger the reserve decides, and maxOutputTokens is the
    // last named fallback before the default headroom.
    expect(agentContextBudgetForModel({
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      contextPolicy: { reserveOutputTokens: 0, keepRecentTokens: 20_000, compactTrigger: 0 },
    })).toEqual({ windowTokens: 200_000, triggerTokens: 136_000 });
    expect(agentContextBudgetForModel({ contextWindowTokens: 128_000 }))
      .toEqual({ windowTokens: 128_000, triggerTokens: 111_616 });
  });

  it('has no window to show when the model does not report one', () => {
    expect(agentContextBudgetForModel({})).toBeNull();
    expect(agentContextBudgetForModel({ contextWindowTokens: 0 })).toBeNull();
    expect(agentContextBudgetForModel({ contextWindowTokens: Number.NaN })).toBeNull();
  });
});
