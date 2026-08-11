/** Lens-layer helpers over the shared document status semantics. */
import type { IrisDoc, IrisWorkspace } from '@shared/types';
import {
  isActiveIssueStatus,
  isInactiveOpenIssueStatus,
  isResolvedIssueStatus,
} from '@shared/document-status';

/** Unknown/missing/deviant soft values stay visible by shared fallback policy. */
export function isActiveIssue(doc: IrisDoc): boolean {
  return isActiveIssueStatus(doc.status);
}

export function isInactiveOpenIssue(doc: IrisDoc): boolean {
  return isInactiveOpenIssueStatus(doc.status);
}

export function isResolvedIssue(doc: IrisDoc): boolean {
  return isResolvedIssueStatus(doc.status);
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
