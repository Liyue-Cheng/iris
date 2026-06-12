/**
 * Labels are a SOFT vocabulary with no registry (red line: structure is
 * inferred, never declared): the label set IS the union of labels actually
 * present in the project's docs, and a label's color is a deterministic
 * hash of its name onto the Rose Pine accent palette. Last use disappears →
 * label disappears. No management UI.
 */
import type { IrisWorkspace } from '@shared/types';

/** Rose Pine accents (theme-variant aware via CSS vars). */
const ACCENT_VARS = [
  '--rp-love',
  '--rp-gold',
  '--rp-rose',
  '--rp-pine',
  '--rp-foam',
  '--rp-iris',
] as const;

/** Deterministic name → accent CSS var (FNV-1a, stable across sessions). */
export function labelColorVar(label: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ACCENT_VARS[(h >>> 0) % ACCENT_VARS.length]!;
}

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
