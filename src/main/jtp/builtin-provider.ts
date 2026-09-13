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

export function jtpRequestToLegacyInput(request: JtpInvokeRequest, cwd: string): AgentToolOperationInput {
  const args = request.arguments;
  const path = typeof args.path === 'string' ? args.path : '';
  const absolutePath = path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) ? path : `${cwd}/${path}`;
  if (request.tool === 'read') return { tool: 'read', operation: 'readFile', absolutePath, ...(typeof args.offset === 'number' ? { offset: args.offset } : {}), ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) };
  if (request.tool === 'edit') return { tool: 'edit', operation: 'writeFile', absolutePath, edits: Array.isArray(args.edits) ? args.edits.filter((item): item is { oldText: string; newText: string } => Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).oldText === 'string' && typeof (item as Record<string, unknown>).newText === 'string')) : [] };
  if (request.tool === 'write') return { tool: 'write', operation: 'writeFile', absolutePath, content: typeof args.content === 'string' ? args.content : '' };
  if (request.tool === 'terminal') return { tool: 'terminal', operation: 'exec', command: typeof args.command === 'string' ? args.command : '', intent: args.intent === 'operation' ? 'operation' : 'information', cwd, timeout: typeof args.timeout === 'number' ? args.timeout : 1 };
  if (request.tool === 'task_start') return { tool: 'task_start', operation: 'start', command: String(args.command ?? ''), title: String(args.title ?? '') };
  if (request.tool === 'task_get') return { tool: 'task_get', operation: 'get', taskId: String(args.taskId ?? '') };
  if (request.tool === 'task_list') return { tool: 'task_list', operation: 'list' };
  return { tool: 'task_cancel', operation: 'cancel', taskId: String(args.taskId ?? '') };
}
