import type { AgentToolOperationInput, AgentToolOperationResult } from '@shared/agent-protocol';
import type { JtpInvokeRequest, JtpResponse } from './protocol';
import type { JtpExecutionContext, JtpProvider } from './provider';

export type BuiltinExecutor = (input: AgentToolOperationInput, context: JtpExecutionContext) => Promise<AgentToolOperationResult>;

export class BuiltinProvider implements JtpProvider {
  constructor(private readonly execute: BuiltinExecutor, private readonly toInput: (request: JtpInvokeRequest) => AgentToolOperationInput) {}
  async invoke(request: JtpInvokeRequest, context: JtpExecutionContext): Promise<JtpResponse> {
    const result = await this.execute(this.toInput(request), context);
    return { id: request.id, ok: true, result };
  }
}
