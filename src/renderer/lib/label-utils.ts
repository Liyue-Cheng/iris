/**
 * Labels are a SOFT vocabulary with no registry (red line: structure is
 * inferred, never declared): the label set IS the union of labels actually
 * present in the project's docs. Last use disappears → label disappears.
 * A label's color is a deterministic hash of its name onto the Rose Pine
 * accent palette. The same label stays visually stable without a registry or
 * persisted style configuration.
 */
import type { IrisWorkspace } from '@shared/types';

const LABEL_COLORS = ['love', 'gold', 'rose', 'pine', 'foam', 'iris'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

/** Stable FNV-1a mapping from a label string to one accent palette slot. */
export function labelColor(label: string): LabelColor {
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return LABEL_COLORS[(hash >>> 0) % LABEL_COLORS.length]!;
}

/** Union of labels across every document in the workspace tree. */
export function collectAllLabels(root: IrisWorkspace): string[] {
  const labels = new Set<string>();
  const walk = (workspace: IrisWorkspace): void => {
    for (const doc of workspace.docs) {
      for (const label of doc.labels) labels.add(label);
    }
    workspace.children.forEach(walk);
  };
  walk(root);
  return [...labels].sort((a, b) => a.localeCompare(b));
}
