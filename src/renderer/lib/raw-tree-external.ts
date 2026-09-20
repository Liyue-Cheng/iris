import type { IrisWorkspace } from '@shared/types';

export interface RawTreeExternalConnection {
  workspacePath: string;
  workspaceName: string;
  entry: IrisWorkspace['external']['entries'][number];
}

export function collectExternalWorkspaces(root: IrisWorkspace | null): IrisWorkspace[] {
  if (!root) return [];
  return [root, ...root.children.flatMap(collectExternalWorkspaces)];
}

export function externalTargetKey(path: string, windows = navigator.platform.toLowerCase().includes('win')): string {
  return windows ? path.toLowerCase() : path;
}

export function indexExternalConnections(
  workspaces: readonly IrisWorkspace[],
  windows = navigator.platform.toLowerCase().includes('win'),
): Map<string, RawTreeExternalConnection[]> {
  const index = new Map<string, RawTreeExternalConnection[]>();
  for (const workspace of workspaces) {
    for (const entry of workspace.external.entries) {
      if (!entry.absolutePath) continue;
      const key = externalTargetKey(entry.absolutePath, windows);
      const current = index.get(key) ?? [];
      current.push({ workspacePath: workspace.path, workspaceName: workspace.name, entry });
      index.set(key, current);
    }
  }
  return index;
}
