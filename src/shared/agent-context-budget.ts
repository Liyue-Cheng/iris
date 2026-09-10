import type { IrisAgentContextBudget, IrisAgentModelOption } from './types';

/** Window assumed when neither the model nor its policy names one. */
export const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 128_000;
/** Output headroom reserved so a request at the trigger still has room to answer. */
export const DEFAULT_AGENT_RESERVE_OUTPUT_TOKENS = 16_384;

export interface AgentContextTriggerInput {
  contextWindow?: number | undefined;
  reserveTokens?: number | undefined;
  triggerTokens?: number | undefined;
}

/**
 * The point at which a request is compacted before it is sent: an explicit
 * trigger wins, otherwise the window minus the reserved output headroom. Main's
 * preflight and the renderer's catalog fallback both resolve through this one
 * rule, so the tick drawn in the UI cannot drift from the line the runtime acts
 * on.
 */
export function agentContextTriggerTokens(input: AgentContextTriggerInput = {}): number {
  const contextWindow = Math.max(
    1,
    Math.floor(input.contextWindow ?? DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS),
  );
  if (input.triggerTokens !== undefined) {
    return Math.max(1, Math.min(contextWindow - 1, input.triggerTokens));
  }
  const reserve = Math.min(input.reserveTokens ?? DEFAULT_AGENT_RESERVE_OUTPUT_TOKENS, contextWindow - 1);
  return Math.max(1, contextWindow - reserve);
}

/**
 * The window a catalog model is measured against, or null when it reports none.
 * This is only a fallback for a Session that has no persisted budget yet (a
 * fresh branch, or a snapshot taken before budgets were stored).
 */
export function agentContextBudgetForModel(
  model: Pick<IrisAgentModelOption, 'contextWindowTokens' | 'maxOutputTokens' | 'contextPolicy'>,
): IrisAgentContextBudget | null {
  const contextWindow = model.contextWindowTokens;
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  // Falsy policy numbers mean "not configured", exactly as main reads them.
  const reserveTokens = model.contextPolicy?.reserveOutputTokens || model.maxOutputTokens || undefined;
  const triggerTokens = model.contextPolicy?.compactTrigger || undefined;
  return {
    windowTokens: Math.max(1, Math.floor(contextWindow)),
    triggerTokens: agentContextTriggerTokens({
      contextWindow,
      reserveTokens,
      triggerTokens,
    }),
  };
}
