import { Type } from 'typebox';

export type JtpBuiltinToolId = 'read' | 'edit' | 'write' | 'terminal' | 'task_start' | 'task_get' | 'task_list' | 'task_cancel';

export interface JtpToolDescriptor {
  id: JtpBuiltinToolId;
  title: string;
  description: string;
  input: unknown;
  provider: 'builtin' | 'mcp';
  enabledByDefault: boolean;
}

export const JTP_BUILTIN_TOOLS: readonly JtpToolDescriptor[] = [
  { id: 'read', title: 'Read file', description: 'Read a project file or image.', input: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }), provider: 'builtin', enabledByDefault: true },
  { id: 'edit', title: 'Edit file', description: 'Replace text in a project file.', input: Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })) }), provider: 'builtin', enabledByDefault: true },
  { id: 'write', title: 'Write file', description: 'Create or overwrite a project file.', input: Type.Object({ path: Type.String(), content: Type.String() }), provider: 'builtin', enabledByDefault: true },
  { id: 'terminal', title: 'Terminal', description: 'Execute a bounded command in the project.', input: Type.Object({ command: Type.String(), intent: Type.String(), timeout: Type.Number() }), provider: 'builtin', enabledByDefault: true },
  { id: 'task_start', title: 'Start background task', description: 'Start a long-running task.', input: Type.Object({ command: Type.String(), title: Type.String() }), provider: 'builtin', enabledByDefault: true },
  { id: 'task_get', title: 'Get task', description: 'Read a background task snapshot.', input: Type.Object({ taskId: Type.String() }), provider: 'builtin', enabledByDefault: true },
  { id: 'task_list', title: 'List tasks', description: 'List background tasks.', input: Type.Object({}), provider: 'builtin', enabledByDefault: true },
  { id: 'task_cancel', title: 'Cancel task', description: 'Cancel a background task.', input: Type.Object({ taskId: Type.String() }), provider: 'builtin', enabledByDefault: true },
];

export function enabledJtpToolIds(config?: Partial<Record<JtpBuiltinToolId, boolean>>): Set<JtpBuiltinToolId> {
  return new Set(JTP_BUILTIN_TOOLS.filter((tool) => config?.[tool.id] ?? tool.enabledByDefault).map((tool) => tool.id));
}
