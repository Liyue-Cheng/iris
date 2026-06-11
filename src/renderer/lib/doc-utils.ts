/**
 * Lens-layer helpers. The one place the renderer interprets a SOFT value:
 * deciding whether an issue counts as "active" for the left-pane lens
 * (resolved issues stay out of sight; the M4 collection view still shows
 * them). Fixed literal set — deterministic, documented, no heuristics
 * beyond it.
 */
import type { IrisDoc } from '@shared/types';

const RESOLVED_STATUSES = new Set(['done', 'resolved', 'closed', 'cancelled', 'wontfix']);

/** Active = not clearly resolved. Unknown/missing/deviant values stay visible. */
export function isActiveIssue(doc: IrisDoc): boolean {
  if (doc.status === null) return true;
  return !RESOLVED_STATUSES.has(doc.status.trim().toLowerCase());
}

export function docDisplayTitle(doc: IrisDoc): string {
  return doc.title ?? doc.name.replace(/\.md$/i, '');
}
