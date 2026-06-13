/**
 * Labels are a SOFT vocabulary with no registry (red line: structure is
 * inferred, never declared): the label set IS the union of labels actually
 * present in the project's docs. Last use disappears → label disappears.
 * Colors come from the configurable label → style table (styles-store);
 * unmapped labels render with the gray default.
 */
import type { IrisWorkspace } from '@shared/types';

/** Union of labels across every doc in the tree (sorted, deduped). */
export function collectAllLabels(root: IrisWorkspace): string[] {
  const set = new Set<string>();
  const walk = (ws: IrisWorkspace): void => {
    for (const doc of ws.docs) for (const l of doc.labels) set.add(l);
    ws.children.forEach(walk);
  };
  walk(root);
  return [...set].sort((a, b) => a.localeCompare(b));
}
