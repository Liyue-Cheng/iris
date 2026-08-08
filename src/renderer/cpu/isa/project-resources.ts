export const PROJECT_SCOPE_RESOURCE = 'window:project-scope';

export const projectScopeRead = (): { id: string; mode: 'read' } => ({
  id: PROJECT_SCOPE_RESOURCE,
  mode: 'read',
});

export const projectScopeWrite = (): { id: string; mode: 'write' } => ({
  id: PROJECT_SCOPE_RESOURCE,
  mode: 'write',
});
