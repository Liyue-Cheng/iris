import type { AgentHistorySnapshot } from '@shared/agent-protocol';
import type { AgentSessionAggregate, AgentTurn } from './session-model';

export interface AgentTraceIntent {
  id: string;
  content: string;
  state: AgentSessionAggregate['intents'][number]['state'];
  createdAt: number;
  turns: AgentTurn[];
}

export interface AgentTrace {
  intents: AgentTraceIntent[];
}

export interface AgentContextPolicy {
  maxIntents?: number;
}

/** The active trace is independent of runtime and invoke attempts. */
export function buildAgentTrace(session: AgentSessionAggregate): AgentTrace {
  const intents = new Map(session.intents.map((intent) => [intent.id, intent]));
  return {
    intents: session.activeIntentIds.flatMap((intentId) => {
      const intent = intents.get(intentId);
      if (!intent) return [];
      return [{
        id: intent.id,
        content: intent.content,
        state: intent.state,
        createdAt: intent.createdAt,
        turns: session.turns.filter((turn) => turn.intentId === intent.id).map((turn) => structuredClone(turn)),
      }];
    }),
  };
}

/** Context is a pure function of Trace and an explicit compaction policy. */
export function buildAgentContext(
  trace: AgentTrace,
  policy: AgentContextPolicy = {},
): Omit<AgentHistorySnapshot, 'anchor' | 'revision'> {
  const count = policy.maxIntents === undefined
    ? trace.intents.length
    : Math.max(0, Math.min(policy.maxIntents, trace.intents.length));
  const messages: AgentHistorySnapshot['messages'] = [];
  for (const intent of trace.intents.slice(trace.intents.length - count)) {
    if (intent.state === 'running' && intent.turns.length === 0) continue;
    messages.push({
      id: `intent:${intent.id}`,
      intentId: intent.id,
      role: 'user',
      content: intent.content,
      createdAt: intent.createdAt,
    });
    for (const turn of intent.turns) appendTurnContext(messages, intent, turn);
  }
  return { messages };
}

export function buildAgentContextFromSession(
  session: AgentSessionAggregate,
  policy?: AgentContextPolicy,
): AgentHistorySnapshot {
  return {
    revision: session.revision,
    anchor: { ...session.anchor },
    ...buildAgentContext(buildAgentTrace(session), policy),
  };
}

function appendTurnContext(
  messages: AgentHistorySnapshot['messages'],
  intent: AgentTraceIntent,
  turn: AgentTurn,
): void {
  if (!turn.assistant) return;
  messages.push({
    id: `assistant:${turn.id}`,
    intentId: intent.id,
    turnId: turn.id,
    role: 'assistant',
    content: turn.assistant.content,
    toolCalls: structuredClone(turn.assistant.toolCalls),
    createdAt: turn.assistant.createdAt,
  });
  const results = new Map(turn.toolResults.map((result) => [result.toolCallId, result]));
  for (const call of turn.assistant.toolCalls) {
    const result = results.get(call.id);
    messages.push(result ? {
      id: `tool:${turn.id}:${call.id}`,
      intentId: intent.id,
      turnId: turn.id,
      role: 'tool',
      content: result.content,
      toolCallId: call.id,
      tool: call.tool,
      isError: result.isError,
      createdAt: result.createdAt,
    } : {
      id: `tool-interrupted:${turn.id}:${call.id}`,
      intentId: intent.id,
      turnId: turn.id,
      role: 'tool',
      content: 'The tool result was not committed. Re-check current state before continuing.',
      toolCallId: call.id,
      tool: call.tool,
      isError: true,
      createdAt: turn.settledAt ?? turn.createdAt,
    });
  }
}

export interface AnchorLinePatch {
  start: number;
  deleteCount: number;
  lines: string[];
}

/** A structural line patch that preserves ordering and duplicate lines. */
export function diffAnchorText(previous: string, current: string): AnchorLinePatch[] {
  if (previous === current) return [];
  const before = previous.split(/\r?\n/u);
  const after = current.split(/\r?\n/u);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  return [{
    start: prefix,
    deleteCount: before.length - prefix - suffix,
    lines: after.slice(prefix, after.length - suffix),
  }];
}

export function renderAnchorMaterial(baseline: string, current: string): string {
  const patch = diffAnchorText(baseline, current);
  if (patch.length === 0) return `<baseline>\n${baseline}\n</baseline>`;
  return [
    `<baseline>\n${baseline}\n</baseline>`,
    `<changes format="line-patch">\n${JSON.stringify(patch)}\n</changes>`,
  ].join('\n');
}
