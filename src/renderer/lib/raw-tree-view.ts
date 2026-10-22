import type { RawTreeNode } from '@shared/types';
import type { LensSort } from '@renderer/stores/lens-prefs';
import { compareDisplayText } from './locale';

export function normalizeFileFilter(filter: string): string {
  return filter.trim().replaceAll('\\', '/').toLowerCase();
}

/** Keep matching paths and their ancestors, sorting siblings without changing scan data. */
export function projectRawTree(root: RawTreeNode, sort: LensSort, filter: string): RawTreeNode | null {
  const query = normalizeFileFilter(filter);
  const compare = (a: RawTreeNode, b: RawTreeNode): number => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    if (sort === 'mtime' && a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return compareDisplayText(a.name, b.name) || a.path.localeCompare(b.path);
  };
  const visit = (node: RawTreeNode, ancestorMatched = false): RawTreeNode | null => {
    // The synthetic project root is context, not a match for every project file.
    const matched = !query || ancestorMatched || (node.path !== '' && (
      node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)
    ));
    if (node.kind === 'file') return matched ? node : null;
    const children = (node.children ?? [])
      .map((child) => visit(child, matched))
      .filter((child): child is RawTreeNode => child !== null)
      .sort(compare);
    return matched || children.length ? { ...node, children } : null;
  };
  return visit(root);
}
