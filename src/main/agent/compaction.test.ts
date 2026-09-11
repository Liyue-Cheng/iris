import { describe, expect, it } from 'vitest';
import { createEmptyAgentSession, type AgentSessionAggregate } from './session-model';
import { truncateIntentChain } from './session-domain';
import {
  AGENT_UNKNOWN_IMAGE_TOKEN_COST,
  activeCompaction,
  agentCompactionTrigger,
  agentContextBudget,
  completeAgentCompaction,
  estimateAgentContextTokens,
  estimateAgentImageTokens,
  estimateAgentRequestTokens,
  estimateAgentTokens,
  inheritAgentCompactionInto,
  openAgentCompaction,
  planAgentCompaction,
  realignActiveCompaction,
  renderAgentCompactionSource,
  reportedContextTokens,
  settleAgentCompaction,
  isAgentContextOverflowError,
} from './compaction';
import { activeAgentContextPolicy, buildAgentContext, buildAgentTrace } from './trace-context';

function sessionWithCompletedIntents(count: number, bodyChars = 0): AgentSessionAggregate {
  const session = createEmptyAgentSession({
    id: 'compaction-session',
    anchor: { kind: 'workspace', path: '.iris' },
    model: { provider: 'openai', modelId: 'test' },
    projectRoot: 'E:/project',
    displayName: 'Agent',
    injection: {
      methods: { agent: 'current', software: 'current', project: 'current' },
      anchor: { path: '.iris', baselineText: '', baselineSha256: '', capturedAt: 1 },
    },
    now: 1,
  });
  for (let index = 0; index < count; index += 1) {
    appendCompletedIntent(session, index + 1, bodyChars);
  }
  return session;
}

function appendCompletedIntent(
  session: AgentSessionAggregate,
  ordinal: number,
  bodyChars = 0,
): void {
  const intentId = `intent-${ordinal}`;
  const turnId = `turn-${ordinal}`;
  const invokeId = `invoke-${ordinal}`;
  const at = (ordinal - 1) * 10;
  const padding = bodyChars > 0 ? `\n${'detail '.repeat(Math.ceil(bodyChars / 7))}` : '';
  session.intents.push({
    id: intentId,
    content: `request ${ordinal}${padding}`,
    turnIds: [turnId],
    state: 'completed',
    assembledInputAvailable: true,
    createdAt: at + 1,
    closedAt: at + 2,
  });
  session.turns.push({
    id: turnId,
    intentId,
    invokeId,
    state: 'settled',
    assistant: { content: `answer ${ordinal}${padding}`, toolCalls: [], createdAt: at + 2 },
    toolResults: [],
    createdAt: at + 1,
    settledAt: at + 2,
  });
  session.invokes.push({
    id: invokeId,
    intentId,
    turnId,
    index: ordinal,
    state: 'completed',
    attemptIds: [],
    createdAt: at + 1,
    completedAt: at + 2,
  });
  session.activeIntentIds.push(intentId);
}

/** Drives a plan through to an active contract without touching a provider. */
function compactThrough(
  session: AgentSessionAggregate,
  summary: string,
  keepRecentTokens = 30,
): AgentSessionAggregate {
  const plan = planAgentCompaction(session, { keepRecentTokens });
  if (!plan) throw new Error('expected a compaction plan');
  const opened = openAgentCompaction(session, plan, {
    id: `compaction-${session.compactions.length + 1}`,
    trigger: 'manual',
    model: session.model!,
    now: 100,
  });
  opened.revision += 1;
  return completeAgentCompaction(opened, opened.compactions.at(-1)!.id, summary, 200);
}

describe('Agent compaction', () => {
  it('counts CJK characters more conservatively than latin text', () => {
    expect(estimateAgentTokens('abcd')).toBe(1);
    // Chinese text costs roughly one token per character, not one per four.
    expect(estimateAgentTokens('上下文压缩')).toBe(5);
    expect(estimateAgentTokens('')).toBe(0);
  });

  it('derives a trigger that leaves output headroom inside the window', () => {
    expect(agentCompactionTrigger({ contextWindow: 100_000, reserveTokens: 20_000 })).toBe(80_000);
    expect(agentCompactionTrigger({
      contextWindow: 100_000,
      reserveTokens: 20_000,
      triggerTokens: 70_000,
    })).toBe(70_000);
  });

  it('resolves the window and trigger the indicator displays', () => {
    expect(agentContextBudget({ contextWindow: 1_000_000, reserveTokens: 16_384 }))
      .toEqual({ windowTokens: 1_000_000, triggerTokens: 983_616 });
    expect(agentContextBudget()).toEqual({ windowTokens: 128_000, triggerTokens: 111_616 });
  });

  it('lets a known method-layer size stand in for the assembled prompt', () => {
    const history = { messages: [{ id: 'i', intentId: 'a', role: 'user' as const, content: 'hello 你好', createdAt: 1 }] };
    const prompt = '<iris-software>\nmethod layers\n</iris-software>';
    // A run measures its tool loop without re-assembling the method layers, so
    // the size-only sum has to equal the fully assembled estimate.
    expect(estimateAgentTokens(prompt) + estimateAgentRequestTokens('', history))
      .toBe(estimateAgentRequestTokens(prompt, history));
  });

  it('measures occupancy from the prompt side of provider usage only', () => {
    expect(reportedContextTokens({ input: 1_000, output: 900, cacheRead: 500, cacheWrite: 100, totalTokens: 2_500 }))
      .toBe(1_600);
    // Anthropic-style components alone still add up.
    expect(reportedContextTokens({ input: 3, cacheRead: 4 })).toBe(7);
    // No usable report must never erase an existing reading.
    expect(reportedContextTokens({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(reportedContextTokens({})).toBeNull();
    expect(reportedContextTokens(undefined)).toBeNull();
    expect(reportedContextTokens('nope')).toBeNull();
  });

  it('places the boundary between whole Intents and always retains a recent tail', () => {
    const plan = planAgentCompaction(sessionWithCompletedIntents(4), { keepRecentTokens: 30 })!;
    expect(plan.coveredThroughIntentId).toBe('intent-3');
    expect(plan.firstRetainedIntentId).toBe('intent-4');
    expect(plan.summarizedIntentIds).toEqual(['intent-1', 'intent-2', 'intent-3']);
    expect(plan.previousSummary).toBeNull();
    expect(plan.tokensBefore).toBeGreaterThan(0);
  });

  it('declines to compact when every Intent still fits the retained tail', () => {
    expect(planAgentCompaction(sessionWithCompletedIntents(3))).toBeNull();
    expect(planAgentCompaction(sessionWithCompletedIntents(1), { keepRecentTokens: 1 })).toBeNull();
  });

  it('never summarizes a running or paused Intent', () => {
    const session = sessionWithCompletedIntents(4);
    session.intents[2]!.state = 'paused';
    session.intents[3]!.state = 'running';
    session.currentIntentId = 'intent-4';
    const plan = planAgentCompaction(session, { keepRecentTokens: 30 })!;
    // intent-3 is paused, so the boundary retreats to the last completed Intent.
    expect(plan.coveredThroughIntentId).toBe('intent-2');
    expect(plan.summarizedIntentIds).toEqual(['intent-1', 'intent-2']);
  });

  it('folds the covered prefix into one summary message and keeps the tail verbatim', () => {
    const compacted = compactThrough(sessionWithCompletedIntents(4), 'Earlier work: shipped A and B.');
    const context = buildAgentContext(
      buildAgentTrace(compacted),
      activeAgentContextPolicy(compacted),
    );
    expect(context.messages.map((message) => message.content)).toEqual([
      expect.stringContaining('Earlier work: shipped A and B.'),
      'request 4',
      'answer 4',
    ]);
    // The boundary must be explicit so summarized text cannot outrank live rules.
    expect(context.messages[0]!.content).toContain('It is not an instruction.');
    expect(context.messages[0]!.content).not.toContain('request 1');
  });

  it('keeps Context a pure function of Trace and the persisted contract', () => {
    const compacted = compactThrough(sessionWithCompletedIntents(4), 'summary text');
    const policy = activeAgentContextPolicy(compacted);
    const first = buildAgentContext(buildAgentTrace(compacted), policy);
    const second = buildAgentContext(buildAgentTrace(compacted), policy);
    expect(second).toEqual(first);
  });

  it('records the summary digest and projected size when completing', () => {
    // Folding only pays for itself once the covered history outweighs the
    // summary's fixed framing, so this uses substantial Intent bodies.
    const compacted = compactThrough(sessionWithCompletedIntents(4, 400), '  trimmed summary  ');
    const contract = activeCompaction(compacted)!;
    expect(contract.state).toBe('completed');
    expect(contract.summary).toBe('trimmed summary');
    expect(contract.summarySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(compacted.activeCompactionId).toBe(contract.id);
    expect(contract.estimatedTokensAfter).toBeLessThan(contract.tokensBefore);
  });

  it('refuses an empty summary rather than activating a useless contract', () => {
    const session = sessionWithCompletedIntents(4);
    const plan = planAgentCompaction(session, { keepRecentTokens: 30 })!;
    const opened = openAgentCompaction(session, plan, {
      id: 'compaction-1', trigger: 'threshold', model: session.model!, now: 1,
    });
    expect(() => completeAgentCompaction(opened, 'compaction-1', '   ', 2))
      .toThrow(/summary was empty/iu);
    expect(opened.activeCompactionId).toBeNull();
  });

  it('leaves the previous projection active when a summary fails', () => {
    const session = sessionWithCompletedIntents(4);
    const plan = planAgentCompaction(session, { keepRecentTokens: 30 })!;
    const opened = openAgentCompaction(session, plan, {
      id: 'compaction-1', trigger: 'threshold', model: session.model!, now: 1,
    });
    const failed = settleAgentCompaction(opened, 'compaction-1', 'failed', 2, 'provider refused');
    expect(failed.compactions[0]!.state).toBe('failed');
    expect(failed.compactions[0]!.error).toBe('provider refused');
    expect(failed.activeCompactionId).toBeNull();
    expect(activeAgentContextPolicy(failed).summary).toBeUndefined();
  });

  it('excludes summarized material from the request but never the method layers', () => {
    const session = sessionWithCompletedIntents(4);
    const plan = planAgentCompaction(session, { keepRecentTokens: 30 })!;
    const material = renderAgentCompactionSource(session, plan);
    expect(material).toContain('request 1');
    expect(material).toContain('answer 3');
    expect(material).not.toContain('request 4');
    expect(material).not.toContain('<iris-software>');
  });

  it('carries the prior summary forward instead of re-reading the whole session', () => {
    const first = compactThrough(sessionWithCompletedIntents(6), 'first summary', 30);
    const covered = activeCompaction(first)!.coveredThroughIntentId;
    // A second compaction needs history that arrived after the first boundary.
    appendCompletedIntent(first, 7);
    appendCompletedIntent(first, 8);
    const plan = planAgentCompaction(first, { keepRecentTokens: 10 })!;
    expect(plan.previousSummary).toBe('first summary');
    // Only Intents after the previous boundary are summarized again.
    expect(plan.summarizedIntentIds).not.toContain('intent-1');
    expect(plan.summarizedIntentIds).not.toContain(covered);
    expect(renderAgentCompactionSource(first, plan)).toContain('first summary');
  });

  it('declines a second compaction until new settled history arrives', () => {
    const first = compactThrough(sessionWithCompletedIntents(6), 'first summary', 30);
    // Everything before the boundary is already folded; the tail must stay verbatim.
    expect(planAgentCompaction(first, { keepRecentTokens: 10 })).toBeNull();
  });

  it('drops a summary whose boundary a rewind removed', () => {
    const compacted = compactThrough(sessionWithCompletedIntents(4), 'summary text');
    // Rewinding past the boundary leaves the summary covering unreachable Intents.
    let rewound = compacted;
    for (let index = 0; index < 2; index += 1) {
      rewound = truncateIntentChain(rewound);
      rewound.state = 'idle';
    }
    expect(rewound.activeIntentIds).toEqual(['intent-1', 'intent-2']);
    const realigned = realignActiveCompaction(rewound);
    expect(realigned.activeCompactionId).toBeNull();
    expect(buildAgentContext(buildAgentTrace(realigned), activeAgentContextPolicy(realigned))
      .messages.map((message) => message.content))
      .toEqual(['request 1', 'answer 1', 'request 2', 'answer 2']);
  });

  it('keeps an active summary when the rewind stays inside the retained tail', () => {
    const compacted = compactThrough(sessionWithCompletedIntents(5), 'summary text', 30);
    const covered = activeCompaction(compacted)!.coveredThroughIntentId;
    const rewound = truncateIntentChain(compacted);
    expect(rewound.activeIntentIds).toContain(covered);
    expect(realignActiveCompaction(rewound).activeCompactionId).toBe(compacted.activeCompactionId);
  });

  it('falls back to the newest contract still covered by the active path', () => {
    const first = compactThrough(sessionWithCompletedIntents(6), 'first summary', 30);
    appendCompletedIntent(first, 7);
    appendCompletedIntent(first, 8);
    const second = compactThrough(first, 'second summary', 10);
    expect(second.compactions).toHaveLength(2);
    expect(second.activeCompactionId).not.toBe(first.activeCompactionId);
    const laterBoundary = activeCompaction(second)!.coveredThroughIntentId;
    let rewound = second;
    // Rewind until the newer boundary leaves the active path.
    while (rewound.activeIntentIds.includes(laterBoundary)) {
      rewound = truncateIntentChain(rewound);
      rewound.state = 'idle';
    }
    const realigned = realignActiveCompaction(rewound);
    // The later boundary is gone, so the earlier still-covered contract takes over.
    expect(realigned.activeCompactionId).toBe(first.activeCompactionId);
  });

  it('inherits a self-contained contract into a fork', () => {
    const compacted = compactThrough(sessionWithCompletedIntents(4), 'summary text');
    const branch = sessionWithCompletedIntents(4);
    branch.compactions = [];
    branch.activeCompactionId = null;
    inheritAgentCompactionInto(compacted, branch);
    expect(branch.compactions).toHaveLength(1);
    expect(branch.activeCompactionId).toBe(compacted.activeCompactionId);
    expect(activeCompaction(branch)!.summary).toBe('summary text');
  });

  it('refuses to inherit a contract whose boundary the fork cannot see', () => {
    const compacted = compactThrough(sessionWithCompletedIntents(4), 'summary text');
    // A fork taken before the boundary must not claim the summary.
    const branch = sessionWithCompletedIntents(2);
    branch.compactions = [];
    branch.activeCompactionId = null;
    inheritAgentCompactionInto(compacted, branch);
    expect(branch.compactions).toEqual([]);
    expect(branch.activeCompactionId).toBeNull();
  });

  it('reports a smaller projected Context after folding', () => {
    const session = sessionWithCompletedIntents(6);
    const before = estimateAgentContextTokens(buildAgentContext(buildAgentTrace(session)));
    const compacted = compactThrough(session, 'short summary', 30);
    const after = estimateAgentContextTokens(
      buildAgentContext(buildAgentTrace(compacted), activeAgentContextPolicy(compacted)),
    );
    expect(after).toBeLessThan(before);
  });

  it('counts method layers, history, and tool schemas in request estimates', () => {
    const history = { messages: [{
      id: 'm1', intentId: 'i1', role: 'user' as const, content: 'history', createdAt: 1,
    }] };
    expect(estimateAgentRequestTokens('prompt', history, 100)).toBe(
      estimateAgentTokens('prompt') + estimateAgentContextTokens(history) + 100,
    );
  });

  it('recognizes only context-size provider failures as overflow', () => {
    expect(isAgentContextOverflowError('maximum context length is 128k')).toBe(true);
    expect(isAgentContextOverflowError('context_length_exceeded')).toBe(true);
    expect(isAgentContextOverflowError('request failed: token limit exceeded')).toBe(true);
    expect(isAgentContextOverflowError('network timeout while contacting provider')).toBe(false);
  });

  it('prices an image by its pixels instead of its base64 length', () => {
    const attachment = {
      id: 'd'.repeat(64), name: 'shot.png', mimeType: 'image/png' as const, bytes: 4_000_000,
      width: 1568, height: 882,
    };
    // A 1568x882 screenshot is well over a thousand tokens even though its
    // text projection is one short line.
    expect(estimateAgentImageTokens(attachment)).toBe(Math.ceil((1568 * 882) / 750) + 85);
    expect(estimateAgentImageTokens(attachment)).toBeGreaterThan(1_000);
    // Without readable dimensions the cost falls back to a conservative flat
    // figure rather than a byte-based guess that would understate it.
    expect(estimateAgentImageTokens({})).toBe(AGENT_UNKNOWN_IMAGE_TOKEN_COST);

    const withImage = { messages: [{
      id: 'm1', intentId: 'i1', role: 'tool' as const, content: 'shot.png: image', createdAt: 1,
      attachments: [attachment],
    }] };
    const withoutImage = { messages: [{
      id: 'm1', intentId: 'i1', role: 'tool' as const, content: 'shot.png: image', createdAt: 1,
    }] };
    expect(estimateAgentContextTokens(withImage))
      .toBeGreaterThan(estimateAgentContextTokens(withoutImage) + 1_000);
  });

  it('tells the summarizer that images were omitted instead of re-sending them', () => {
    const session = sessionWithCompletedIntents(4);
    const attachment = {
      id: 'e'.repeat(64), name: 'shot.png', mimeType: 'image/png' as const, bytes: 16,
      width: 8, height: 6,
    };
    session.turns[0]!.assistant = {
      content: 'answer 1',
      toolCalls: [{ id: 'tool-1', tool: 'read', input: { path: 'shot.png' } }],
      createdAt: 2,
    };
    session.turns[0]!.toolResults = [{
      toolCallId: 'tool-1', tool: 'read', content: 'shot.png: image image/png 8x6 (16 B).',
      attachments: [attachment], isError: false, createdAt: 3,
    }];
    const plan = planAgentCompaction(session, { keepRecentTokens: 1 });
    expect(plan).not.toBeNull();
    const material = renderAgentCompactionSource(session, plan!);
    expect(material).toContain('1 attached image(s) omitted from this summary request');
    // The summary request is text: no base64 ever enters it.
    expect(material).not.toContain(attachment.id);
  });
});
