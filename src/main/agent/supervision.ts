export interface AgentSupervisionFact {
  terminalId: string;
  cursorStart: number;
  cursorEnd: number;
  outcome: 'normal' | 'suspicious' | 'error';
  usageTokens?: number;
}

export interface AgentSupervisionInput {
  terminalId: string;
  command: string;
  cursorStart: number;
  cursorEnd: number;
  overlapOutput: string;
  incrementalOutput: string;
  processState: 'running' | 'exited';
}

export interface AgentSupervisionResult {
  outcome: AgentSupervisionFact['outcome'];
  evidence?: string;
  usageTokens?: number;
}

export type AgentSupervisionCall = (
  input: AgentSupervisionInput & {
    systemRule: string;
    tools: readonly [];
  },
) => Promise<AgentSupervisionResult>;

export const AGENT_SUPERVISION_RULE =
  'Inspect only the supplied command output increment. Report suspicious behavior with concise evidence. Do not continue the task or request tools.';

export class AgentSupervisionLog {
  private readonly facts: AgentSupervisionFact[] = [];

  record(fact: AgentSupervisionFact): void {
    this.facts.push({ ...fact });
  }

  diagnostics(): AgentSupervisionFact[] {
    return this.facts.map((fact) => ({ ...fact }));
  }
}

/** Deliberately has no formal-history dependency or mutation callback. */
export async function runIsolatedSupervision(
  call: AgentSupervisionCall,
  input: AgentSupervisionInput,
  diagnostics: AgentSupervisionLog,
): Promise<AgentSupervisionResult> {
  const result = await call({ ...input, systemRule: AGENT_SUPERVISION_RULE, tools: [] });
  diagnostics.record({
    terminalId: input.terminalId,
    cursorStart: input.cursorStart,
    cursorEnd: input.cursorEnd,
    outcome: result.outcome,
    ...(result.usageTokens === undefined ? {} : { usageTokens: result.usageTokens }),
  });
  return result;
}
