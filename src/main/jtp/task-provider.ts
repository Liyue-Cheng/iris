import type { JtpBuiltinResult } from '@shared/jtp-protocol';
import type { JtpInvokeRequest, JtpResponse } from './protocol';
import type { JtpExecutionContext, JtpProvider } from './provider';
import { jtpRequestToBuiltinInput } from './builtin-provider';

export class TaskProvider implements JtpProvider {
  constructor(private readonly cwd: string, private readonly execute: (request: JtpInvokeRequest, context: JtpExecutionContext) => Promise<JtpBuiltinResult>) {}
  async invoke(request: JtpInvokeRequest, context: JtpExecutionContext): Promise<JtpResponse> {
    const input = jtpRequestToBuiltinInput(request, this.cwd);
    if (!input.tool.startsWith('task_')) {
      return { id: request.id, ok: false, error: { kind: 'protocol', code: 'WRONG_PROVIDER', message: `Task provider cannot execute ${request.tool}.`, retryable: false } };
    }
    return { id: request.id, ok: true, result: await this.execute(request, context) };
  }
}


