import { Type } from 'typebox';
import type { JtpToolDescriptor } from './descriptor';

export const JTP_BUILTIN_DESCRIPTORS: readonly JtpToolDescriptor[] = [
  { id: 'read', title: 'Read file', description: 'Read a project file or image. Use offset and limit for large text; images return pixels and metadata.', inputSchema: Type.Object({ path: Type.String({ minLength: 1 }), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })) }), outputSchema: Type.Object({ kind: Type.String() }), effects: 'read', provider: 'builtin', enabledByDefault: true },
  { id: 'edit', title: 'Edit file', description: 'Replace exact oldText blocks with newText. Every block must match uniquely; returns a change summary.', inputSchema: Type.Object({ path: Type.String({ minLength: 1 }), edits: Type.Array(Type.Object({ oldText: Type.String({ minLength: 1 }), newText: Type.String() }), { minItems: 1, maxItems: 100 }) }), effects: 'write', provider: 'builtin', enabledByDefault: true },
  { id: 'write', title: 'Write file', description: 'Create or overwrite a text file and return a change summary.', inputSchema: Type.Object({ path: Type.String(), content: Type.String() }), effects: 'write', provider: 'builtin', enabledByDefault: true },
  { id: 'terminal', title: 'Terminal', description: 'Execute a visible command. Declare information for read-only work or operation for side effects, and provide a finite timeout.', inputSchema: Type.Object({ command: Type.String({ minLength: 1 }), intent: Type.Union([Type.Literal('information'), Type.Literal('operation')]), timeout: Type.Number({ minimum: 1, maximum: 3600 }) }), effects: 'external', provider: 'builtin', enabledByDefault: true },
  { id: 'task_start', title: 'Start background task', description: 'Start a watch, server, or other long-running command. Returns a taskId.', inputSchema: Type.Object({ command: Type.String(), title: Type.String() }), effects: 'external', provider: 'builtin', enabledByDefault: true },
  { id: 'task_get', title: 'Get task', description: 'Read a task snapshot and bounded log tail.', inputSchema: Type.Object({ taskId: Type.String() }), effects: 'read', provider: 'builtin', enabledByDefault: true },
  { id: 'task_list', title: 'List tasks', description: 'List active or completed background tasks.', inputSchema: Type.Object({}), effects: 'read', provider: 'builtin', enabledByDefault: true },
  { id: 'task_cancel', title: 'Cancel task', description: 'Request cancellation of a background task.', inputSchema: Type.Object({ taskId: Type.String() }), effects: 'write', provider: 'builtin', enabledByDefault: true },
];

export type JtpBuiltinToolId = (typeof JTP_BUILTIN_DESCRIPTORS)[number]['id'];
export function enabledJtpToolIds(config?: Partial<Record<JtpBuiltinToolId, boolean>>): Set<string> {
  return new Set(JTP_BUILTIN_DESCRIPTORS.filter((tool) => config?.[tool.id] ?? tool.enabledByDefault).map((tool) => tool.id));
}
