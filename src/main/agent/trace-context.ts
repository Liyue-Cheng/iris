import type { AgentHistorySnapshot } from '@shared/agent-protocol';
import type {
  AgentProviderFrame,
  AgentSessionAggregate,
} from './session-model';

export interface AgentTraceTurn {
  turnId: string;
  intentId?: string;
  user?: AgentProviderFrame;
  outputs: AgentProviderFrame[];
}

export interface AgentTrace {
  turns: AgentTraceTurn[];
  effectivePrefixLength: number;
}

export type AgentContextSnapshot = Omit<AgentHistorySnapshot, 'anchor'>;

/**
 * Build the turn-level trace from the append-only provider frame ledger.
 * This function has no mutation and intentionally ignores invoke attempts.
 */
export function buildAgentTrace(session: AgentSessionAggregate): AgentTrace {
  const turnOrder = session.turns.map((turn) => turn.id);
  const byTurn = new Map<string, AgentTraceTurn>();
  for (const turn of session.turns) {
    byTurn.set(turn.id, {
      turnId: turn.id,
      ...(turn.intentId ? { intentId: turn.intentId } : {}),
      outputs: [],
    });
  }
  for (const frame of session.transcript) {
    const target = byTurn.get(frame.turnId);
    if (!target) continue;
    if (frame.role === 'user') target.user ??= structuredClone(frame);
    else target.outputs.push(structuredClone(frame));
  }
  const turns = turnOrder.flatMap((id) => {
    const turn = byTurn.get(id);
    return turn ? [turn] : [];
  });
  const storedPrefix = session.effectiveTraceLength === 0 && turns.length > 0 && session.undoReceipts.length === 0
    ? turns.length
    : (session.effectiveTraceLength ?? turns.length);
  const effectivePrefixLength = Math.max(
    0,
    Math.min(storedPrefix, turns.length),
  );
  return { turns, effectivePrefixLength };
}

export interface AgentContextOptions {
  maxTurns?: number;
}

/** Pure Context projection used by the worker and history inspection. */
export function buildAgentContext(
  trace: AgentTrace,
  options: AgentContextOptions = {},
): AgentContextSnapshot {
  const maxTurns = options.maxTurns === undefined
    ? trace.effectivePrefixLength
    : Math.max(0, Math.min(options.maxTurns, trace.effectivePrefixLength));
  const messages: AgentHistorySnapshot['messages'] = [];
  for (const turn of trace.turns.slice(0, maxTurns)) {
    if (turn.user) messages.push(frameToHistoryMessage(turn.user));
    for (const output of turn.outputs) messages.push(frameToHistoryMessage(output));
  }
  return { revision: maxTurns, messages };
}

export function buildAgentContextFromSession(
  session: AgentSessionAggregate,
  options?: AgentContextOptions,
): AgentHistorySnapshot {
  const context = buildAgentContext(buildAgentTrace(session), options);
  return {
    ...context,
    revision: session.revision,
    anchor: { ...session.anchor },
  };
}

function frameToHistoryMessage(frame: AgentProviderFrame): AgentHistorySnapshot['messages'][number] {
  return {
    id: frame.id,
    turnId: frame.turnId,
    role: frame.role,
    content: frame.content,
    createdAt: frame.createdAt,
    ...(frame.providerMessage ? { providerMessage: structuredClone(frame.providerMessage) } : {}),
  };
}

/** Small, deterministic line diff for anchor material snapshots. */
export function diffAnchorText(previous: string | undefined, current: string): string {
  if (previous === undefined || previous === current) return '';
  const before = previous.split(/\r?\n/u);
  const after = current.split(/\r?\n/u);
  const lines: string[] = [];
  for (const line of before) if (!after.includes(line)) lines.push(`-${line}`);
  for (const line of after) if (!before.includes(line)) lines.push(`+${line}`);
  return lines.join('\n');
}
