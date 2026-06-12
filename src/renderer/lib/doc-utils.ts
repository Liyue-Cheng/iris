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

/** Soft ordered priority vocabulary (Linear 的简化抄法: 没有图标体系，纯软值). */
export const SOFT_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;

/** frontmatter `priority:` — soft value, rendered literally. */
export function docPriority(doc: IrisDoc): string | null {
  const v = doc.frontmatter?.['priority'];
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number') return String(v);
  return null;
}

/** Sort rank: known values in order, deviant soft values next, none last. */
export function priorityRank(priority: string | null): number {
  if (priority === null) return SOFT_PRIORITIES.length + 1;
  const i = (SOFT_PRIORITIES as readonly string[]).indexOf(priority.toLowerCase());
  return i === -1 ? SOFT_PRIORITIES.length : i;
}
