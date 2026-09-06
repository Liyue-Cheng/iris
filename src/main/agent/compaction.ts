import { createHash } from 'node:crypto';
import type { AgentHistorySnapshot } from '@shared/agent-protocol';
import type { IrisAgentModelRef } from '@shared/types';
import type { AgentCompaction, AgentSessionAggregate } from './session-model';
import { cloneAgentSession } from './session-model';
import { buildAgentContext, buildAgentTrace, type AgentTrace } from './trace-context';

export const AGENT_COMPACTION_PROMPT_VERSION = 1 as const;

/** Conservative allowance for the four runtime tool schemas sent to the provider. */
export const AGENT_TOOL_SCHEMA_TOKEN_BUDGET = 2_048;

/** Retained verbatim history target. Kept well inside typical windows. */
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
/** Output headroom reserved so a compacted request still has room to answer. */
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_CONTEXT_WINDOW = 128_000;

export interface AgentCompactionPlan {
  /** Every Intent up to and including this one becomes summary material. */
  coveredThroughIntentId: string;
  firstRetainedIntentId: string;
  summarizedIntentIds: string[];
  /** Prior summary text when this compaction extends an existing one. */
  previousSummary: string | null;
  tokensBefore: number;
}

export interface AgentCompactionThresholds {
  contextWindow?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  triggerTokens?: number;
}

/**
 * A conservative token estimate. CJK text is roughly one token per character
 * while latin text trends toward four characters per token; counting them
 * separately keeps the estimate from underreporting Chinese-heavy sessions.
 */
export function estimateAgentTokens(text: string): number {
  let cjk = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (
      (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xac00 && code <= 0xd7af) || (code >= 0x20000 && code <= 0x2ebef)
    ) cjk += 1;
  }
  const latin = Math.max(0, [...text].length - cjk);
  return cjk + Math.ceil(latin / 4);
}

export function estimateAgentContextTokens(
  context: Pick<AgentHistorySnapshot, 'messages'>,
): number {
  let tokens = 0;
  for (const message of context.messages) {
    // Role, identifiers and tool envelopes all cost tokens on the wire.
    tokens += 8 + estimateAgentTokens(message.content);
    for (const call of message.toolCalls ?? []) {
      tokens += 8 + estimateAgentTokens(call.tool) + estimateAgentTokens(JSON.stringify(call.input));
    }
  }
  return tokens;
}

/** Estimates the complete provider request, including method layers and tool schemas. */
export function estimateAgentRequestTokens(
  prompt: string,
  context: Pick<AgentHistorySnapshot, 'messages'>,
  toolSchemaTokens = AGENT_TOOL_SCHEMA_TOKEN_BUDGET,
): number {
  return Math.max(0, toolSchemaTokens) + estimateAgentTokens(prompt) +
    estimateAgentContextTokens(context);
}

/** Provider errors that mean the request cannot fit in the model context window. */
export function isAgentContextOverflowError(message: string): boolean {
  return /(?:context[\s_-]*(?:length|window|limit)|maximum\s+(?:context|input)|too\s+many\s+tokens|prompt\s+is\s+too\s+long|token\s+limit|input[\s_-]*length|(?:prompt|input)\s+token(?:\s+count)?\s+(?:exceeds?|over))/iu.test(message);
}

/** The point at which a request should be compacted before it is sent. */
export function agentCompactionTrigger(thresholds: AgentCompactionThresholds = {}): number {
  const contextWindow = thresholds.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  if (thresholds.triggerTokens !== undefined) {
    return Math.max(1, Math.min(contextWindow - 1, thresholds.triggerTokens));
  }
  const reserve = Math.min(thresholds.reserveTokens ?? DEFAULT_RESERVE_TOKENS, contextWindow - 1);
  return Math.max(1, contextWindow - reserve);
}

/**
 * Chooses a boundary that only ever falls between whole Intents. Running and
 * paused Intents can never be summarized, and at least one complete Intent is
 * always retained verbatim so the model keeps recent detail.
 */
export function planAgentCompaction(
  session: AgentSessionAggregate,
  thresholds: AgentCompactionThresholds = {},
): AgentCompactionPlan | null {
  const trace = buildAgentTrace(session);
  const active = activeCompaction(session);
  const alreadyCovered = active
    ? trace.intents.findIndex((intent) => intent.id === active.coveredThroughIntentId)
    : -1;
  const keepRecent = Math.max(1, thresholds.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS);

  // Walk backwards accumulating the verbatim tail we intend to keep.
  let retainFrom = trace.intents.length;
  let retainedTokens = 0;
  while (retainFrom > 0) {
    const candidate = trace.intents[retainFrom - 1]!;
    const cost = estimateIntentTokens(candidate);
    if (retainFrom < trace.intents.length && retainedTokens + cost > keepRecent) break;
    retainedTokens += cost;
    retainFrom -= 1;
  }

  // The boundary must land on a completed Intent strictly after the covered one.
  let covered = retainFrom - 1;
  while (covered >= 0 && trace.intents[covered]!.state !== 'completed') covered -= 1;
  if (covered <= alreadyCovered) return null;
  if (covered >= trace.intents.length - 1) return null;

  const coveredIntent = trace.intents[covered]!;
  const firstRetained = trace.intents[covered + 1]!;
  return {
    coveredThroughIntentId: coveredIntent.id,
    firstRetainedIntentId: firstRetained.id,
    summarizedIntentIds: trace.intents
      .slice(alreadyCovered + 1, covered + 1)
      .map((intent) => intent.id),
    previousSummary: active?.summary ?? null,
    tokensBefore: estimateAgentContextTokens(
      buildAgentContext(trace, activeSummaryPolicy(active)),
    ),
  };
}

/** Renders only the material a summary request needs, never the method layers. */
export function renderAgentCompactionSource(
  session: AgentSessionAggregate,
  plan: AgentCompactionPlan,
): string {
  const trace = buildAgentTrace(session);
  const summarized = new Set(plan.summarizedIntentIds);
  const sections = trace.intents
    .filter((intent) => summarized.has(intent.id))
    .map((intent) => {
      const lines = [`<intent id="${intent.id}">`, `<request>\n${intent.content}\n</request>`];
      for (const turn of intent.turns) {
        if (turn.assistant) lines.push(`<reply>\n${turn.assistant.content}\n</reply>`);
        for (const call of turn.assistant?.toolCalls ?? []) {
          const result = turn.toolResults.find((candidate) => candidate.toolCallId === call.id);
          lines.push(
            `<tool name="${call.tool}"${result?.isError ? ' error="true"' : ''}>\n` +
            `${result ? result.content : '(no result was committed)'}\n</tool>`,
          );
        }
      }
      lines.push('</intent>');
      return lines.join('\n');
    });
  return [
    ...(plan.previousSummary
      ? [`<previous-summary>\n${plan.previousSummary}\n</previous-summary>`]
      : []),
    ...sections,
  ].join('\n\n');
}

export const AGENT_COMPACTION_INSTRUCTION = [
  'Summarize the session history below so work can continue without it.',
  'Write plain prose. Do not call tools. Do not add commentary about summarizing.',
  '',
  'Preserve, in this order of priority:',
  '- The user goals and the acceptance criteria they stated.',
  '- Decisions and constraints that were confirmed, and approaches that were rejected.',
  '- Current implementation state: which files, symbols, and behaviors changed.',
  '- Operations already performed and any side effects that still exist.',
  '- Test results, failure evidence, and problems that remain open.',
  '- Exact names, values, paths, and error strings needed to continue.',
  '',
  'Do not restate project rules, agent instructions, or anchor document contents;',
  'those are supplied fresh on every request. When a previous summary is present,',
  'fold it together with the newer history into one continuous summary.',
].join('\n');

export function openAgentCompaction(
  source: AgentSessionAggregate,
  plan: AgentCompactionPlan,
  input: {
    id: string;
    trigger: AgentCompaction['trigger'];
    model: IrisAgentModelRef;
    now: number;
  },
): AgentSessionAggregate {
  const session = cloneAgentSession(source);
  session.compactions.push({
    id: input.id,
    state: 'running',
    trigger: input.trigger,
    sourceRevision: source.revision,
    coveredThroughIntentId: plan.coveredThroughIntentId,
    firstRetainedIntentId: plan.firstRetainedIntentId,
    summary: '',
    summarySha256: '',
    promptVersion: AGENT_COMPACTION_PROMPT_VERSION,
    model: { ...input.model },
    tokensBefore: plan.tokensBefore,
    measurement: 'estimated',
    createdAt: input.now,
  });
  return session;
}

/**
 * Commits summary text and promotes the contract to active. The source revision
 * is verified first so an in-flight summary can never be applied to history that
 * moved underneath it.
 */
export function completeAgentCompaction(
  source: AgentSessionAggregate,
  compactionId: string,
  summary: string,
  now: number,
): AgentSessionAggregate {
  const text = summary.trim();
  if (!text) throw new Error('Iris Agent compaction summary was empty.');
  const session = cloneAgentSession(source);
  const compaction = session.compactions.find((candidate) => candidate.id === compactionId);
  if (!compaction) throw new Error('Unknown Iris Agent compaction.');
  if (compaction.state !== 'running') throw new Error('Only a running Iris Agent compaction can complete.');
  if (!session.intents.some((intent) => intent.id === compaction.coveredThroughIntentId)) {
    throw new Error('The Iris Agent compaction boundary no longer exists.');
  }
  compaction.state = 'completed';
  compaction.summary = text;
  compaction.summarySha256 = sha256(text);
  compaction.completedAt = now;
  delete compaction.error;
  compaction.estimatedTokensAfter = estimateAgentContextTokens(
    buildAgentContext(buildAgentTrace(session), {
      summary: {
        text,
        coveredThroughIntentId: compaction.coveredThroughIntentId,
        sha256: compaction.summarySha256,
      },
    }),
  );
  session.activeCompactionId = compaction.id;
  return session;
}

export function settleAgentCompaction(
  source: AgentSessionAggregate,
  compactionId: string,
  outcome: 'failed' | 'canceled',
  now: number,
  error?: string,
): AgentSessionAggregate {
  const session = cloneAgentSession(source);
  const compaction = session.compactions.find((candidate) => candidate.id === compactionId);
  if (!compaction || compaction.state !== 'running') return source;
  compaction.state = outcome;
  compaction.completedAt = now;
  if (error) compaction.error = error;
  return session;
}

/**
 * Re-points the active contract after the active Intent path is truncated. A
 * summary survives only while its boundary is still on the path; otherwise the
 * newest still-covered contract takes over, and full history is the floor.
 */
export function realignActiveCompaction(
  source: AgentSessionAggregate,
): AgentSessionAggregate {
  const onPath = new Set(source.activeIntentIds);
  const current = activeCompaction(source);
  if (current && onPath.has(current.coveredThroughIntentId)) return source;
  const fallback = [...source.compactions]
    .reverse()
    .find((compaction) =>
      compaction.state === 'completed' && onPath.has(compaction.coveredThroughIntentId));
  if ((fallback?.id ?? null) === source.activeCompactionId) return source;
  const session = cloneAgentSession(source);
  session.activeCompactionId = fallback?.id ?? null;
  return session;
}

/**
 * Copies the newest contract a branch can stand on by itself. Both boundary
 * Intents must already exist in the branch, so a fork never inherits a summary
 * that claims to cover history the branch cannot see, and never depends on the
 * parent Session's artifacts.
 */
export function inheritAgentCompactionInto(
  source: AgentSessionAggregate,
  branch: AgentSessionAggregate,
): void {
  const available = new Set(branch.intents.map((intent) => intent.id));
  const inherited = [...(source.compactions ?? [])].reverse().find((compaction) =>
    compaction.state === 'completed' &&
    available.has(compaction.coveredThroughIntentId) &&
    available.has(compaction.firstRetainedIntentId));
  if (!inherited) return;
  branch.compactions = [structuredClone(inherited)];
  branch.activeCompactionId = inherited.id;
}

export function activeCompaction(session: AgentSessionAggregate): AgentCompaction | null {
  return session.compactions?.find(
    (compaction) => compaction.id === session.activeCompactionId && compaction.state === 'completed',
  ) ?? null;
}

export function runningCompaction(session: AgentSessionAggregate): AgentCompaction | null {
  return session.compactions?.find((compaction) => compaction.state === 'running') ?? null;
}

function activeSummaryPolicy(active: AgentCompaction | null) {
  return active
    ? {
        summary: {
          text: active.summary,
          coveredThroughIntentId: active.coveredThroughIntentId,
          sha256: active.summarySha256,
        },
      }
    : {};
}

function estimateIntentTokens(intent: AgentTrace['intents'][number]): number {
  let tokens = 8 + estimateAgentTokens(intent.content);
  for (const turn of intent.turns) {
    tokens += 8 + estimateAgentTokens(turn.assistant?.content ?? '');
    for (const call of turn.assistant?.toolCalls ?? []) {
      tokens += 8 + estimateAgentTokens(call.tool) + estimateAgentTokens(JSON.stringify(call.input));
    }
    for (const result of turn.toolResults) tokens += 8 + estimateAgentTokens(result.content);
  }
  return tokens;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
