import { describe, expect, it } from 'vitest';
import {
  ISSUE_STATUS,
  ISSUE_STATUSES,
  REPORT_STATUS,
  classifyIssueStatus,
  classifyReportStatus,
  isActiveIssueStatus,
  isInactiveOpenIssueStatus,
  isResolvedIssueStatus,
  planDocumentStatusTransition,
} from './document-status';

describe('document status semantics', () => {
  it('keeps the official issue vocabulary ordered for menus and sorting', () => {
    expect(ISSUE_STATUSES).toEqual([
      'Todo',
      'In Progress',
      'In Review',
      'Blocked',
      'On Hold',
      'Done',
      'Canceled',
    ]);
  });

  it('models On Hold as inactive and unresolved', () => {
    expect(classifyIssueStatus(ISSUE_STATUS.onHold)).toEqual({
      activity: 'inactive',
      resolution: 'open',
      closeSessionsOnEnter: true,
      completesIssue: false,
    });
    expect(isActiveIssueStatus(ISSUE_STATUS.onHold)).toBe(false);
    expect(isInactiveOpenIssueStatus(ISSUE_STATUS.onHold)).toBe(true);
    expect(isResolvedIssueStatus(ISSUE_STATUS.onHold)).toBe(false);
  });

  it('keeps completion separate from other inactive states', () => {
    expect(classifyIssueStatus(ISSUE_STATUS.done).completesIssue).toBe(true);
    expect(classifyIssueStatus(ISSUE_STATUS.canceled).completesIssue).toBe(false);
    expect(isResolvedIssueStatus(ISSUE_STATUS.done)).toBe(true);
    expect(isResolvedIssueStatus(ISSUE_STATUS.canceled)).toBe(true);
  });

  it('preserves soft-value compatibility and visible unknown fallback', () => {
    expect(classifyIssueStatus('CLOSED').resolution).toBe('resolved');
    expect(classifyIssueStatus('cancelled').resolution).toBe('resolved');
    expect(classifyIssueStatus('Custom')).toEqual(classifyIssueStatus(null));
    expect(isActiveIssueStatus('Custom')).toBe(true);
  });

  it('classifies reports without renderer literal checks', () => {
    expect(classifyReportStatus(REPORT_STATUS.active).activity).toBe('active');
    expect(classifyReportStatus(REPORT_STATUS.backlog).activity).toBe('inactive');
    expect(classifyReportStatus('Custom').activity).toBe('active');
  });
});

describe('document status transition plan', () => {
  it('closes sessions for On Hold without applying Done completion behavior', () => {
    expect(planDocumentStatusTransition('issue', ISSUE_STATUS.onHold, true)).toEqual({
      closeSessions: true,
      checkTodos: false,
    });
  });

  it('applies checkbox completion only to Done when enabled', () => {
    expect(planDocumentStatusTransition('issue', ISSUE_STATUS.done, true)).toEqual({
      closeSessions: true,
      checkTodos: true,
    });
    expect(planDocumentStatusTransition('issue', ISSUE_STATUS.done, false)).toEqual({
      closeSessions: true,
      checkTodos: false,
    });
    expect(planDocumentStatusTransition('issue', ISSUE_STATUS.canceled, true)).toEqual({
      closeSessions: true,
      checkTodos: false,
    });
  });

  it('settles Backlog reports and leaves active or unknown values alone', () => {
    expect(planDocumentStatusTransition('report', REPORT_STATUS.backlog, true)).toEqual({
      closeSessions: true,
      checkTodos: false,
    });
    expect(planDocumentStatusTransition('issue', ISSUE_STATUS.blocked, true)).toEqual({
      closeSessions: false,
      checkTodos: false,
    });
    expect(planDocumentStatusTransition(null, 'Done', true)).toEqual({
      closeSessions: false,
      checkTodos: false,
    });
  });
});
