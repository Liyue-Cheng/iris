/**
 * Lens-layer helpers. The one place the renderer interprets a SOFT value:
 * deciding whether an issue counts as "active" for the left-pane lens
 * (resolved issues stay out of sight; the M4 collection view still shows
 * them). Fixed literal set — deterministic, documented, no heuristics
 * beyond it.
 */
import type { IrisDoc, IrisWorkspace } from '@shared/types';

const RESOLVED_STATUSES = new Set([
  'done',
  'resolved',
  'closed',
  'cancelled',
  'canceled',
  'wontfix',
]);

/** Active = not clearly resolved. Unknown/missing/deviant values stay visible. */
export function isActiveIssue(doc: IrisDoc): boolean {
  if (doc.status === null) return true;
  return !RESOLVED_STATUSES.has(doc.status.trim().toLowerCase());
}

export function docDisplayTitle(doc: IrisDoc): string {
  return doc.title ?? doc.name.replace(/\.md$/i, '');
}

/** Find a doc anywhere in the workspace tree by its project-relative path. */
export function findDocByPath(ws: IrisWorkspace, path: string): IrisDoc | null {
  for (const d of ws.docs) {
    if (d.path === path) return d;
  }
  for (const c of ws.children) {
    const hit = findDocByPath(c, path);
    if (hit) return hit;
  }
  return null;
}
