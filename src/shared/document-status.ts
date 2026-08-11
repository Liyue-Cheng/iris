/** Canonical document statuses and their product-owned behavior. */
export const ISSUE_STATUS = {
  todo: 'Todo',
  inProgress: 'In Progress',
  inReview: 'In Review',
  blocked: 'Blocked',
  onHold: 'On Hold',
  done: 'Done',
  canceled: 'Canceled',
} as const;

export type IssueStatus = (typeof ISSUE_STATUS)[keyof typeof ISSUE_STATUS];
export const ISSUE_STATUSES = Object.freeze(Object.values(ISSUE_STATUS)) as readonly IssueStatus[];

export const REPORT_STATUS = {
  active: 'Active',
  backlog: 'Backlog',
} as const;

export type ReportStatus = (typeof REPORT_STATUS)[keyof typeof REPORT_STATUS];
export const REPORT_STATUSES = Object.freeze(Object.values(REPORT_STATUS)) as readonly ReportStatus[];

export type StatusActivity = 'active' | 'inactive';
export type IssueResolution = 'open' | 'resolved';

export interface DocumentStatusSemantics {
  activity: StatusActivity;
  resolution: IssueResolution;
  /** A UI transition into this status must settle linked terminal sessions first. */
  closeSessionsOnEnter: boolean;
  /** Completion-only behavior such as the optional task-checkbox update. */
  completesIssue: boolean;
}

export type StatusDocumentType = 'issue' | 'report';

export interface StatusTransitionPlan {
  closeSessions: boolean;
  checkTodos: boolean;
}

const ACTIVE_OPEN: DocumentStatusSemantics = Object.freeze({
  activity: 'active',
  resolution: 'open',
  closeSessionsOnEnter: false,
  completesIssue: false,
});
const INACTIVE_OPEN: DocumentStatusSemantics = Object.freeze({
  activity: 'inactive',
  resolution: 'open',
  closeSessionsOnEnter: true,
  completesIssue: false,
});
const RESOLVED: DocumentStatusSemantics = Object.freeze({
  activity: 'inactive',
  resolution: 'resolved',
  closeSessionsOnEnter: true,
  completesIssue: false,
});
const COMPLETED: DocumentStatusSemantics = Object.freeze({
  ...RESOLVED,
  completesIssue: true,
});

export const ISSUE_STATUS_SEMANTICS: Readonly<Record<IssueStatus, DocumentStatusSemantics>> =
  Object.freeze({
    [ISSUE_STATUS.todo]: ACTIVE_OPEN,
    [ISSUE_STATUS.inProgress]: ACTIVE_OPEN,
    [ISSUE_STATUS.inReview]: ACTIVE_OPEN,
    [ISSUE_STATUS.blocked]: ACTIVE_OPEN,
    [ISSUE_STATUS.onHold]: INACTIVE_OPEN,
    [ISSUE_STATUS.done]: COMPLETED,
    [ISSUE_STATUS.canceled]: RESOLVED,
  });

export const REPORT_STATUS_SEMANTICS: Readonly<Record<ReportStatus, DocumentStatusSemantics>> =
  Object.freeze({
    [REPORT_STATUS.active]: ACTIVE_OPEN,
    [REPORT_STATUS.backlog]: INACTIVE_OPEN,
  });

const normalize = (status: string): string => status.trim().toLowerCase();
const issueSemanticsByValue = new Map<string, DocumentStatusSemantics>(
  Object.entries(ISSUE_STATUS_SEMANTICS).map(([status, semantics]) => [normalize(status), semantics]),
);
const reportSemanticsByValue = new Map<string, DocumentStatusSemantics>(
  Object.entries(REPORT_STATUS_SEMANTICS).map(([status, semantics]) => [normalize(status), semantics]),
);

// Preserve the previous soft-value compatibility without promoting these
// exceptional spellings into the canonical status menu.
const LEGACY_RESOLVED_ISSUE_STATUSES = new Set([
  'resolved',
  'closed',
  'cancelled',
  'wontfix',
]);

/** Unknown/missing soft values stay visible and carry no transition side effects. */
export function classifyIssueStatus(status: string | null): DocumentStatusSemantics {
  if (status === null) return ACTIVE_OPEN;
  const normalized = normalize(status);
  return issueSemanticsByValue.get(normalized) ??
    (LEGACY_RESOLVED_ISSUE_STATUSES.has(normalized) ? RESOLVED : ACTIVE_OPEN);
}

/** Unknown/missing report values follow the same visible-by-default fallback. */
export function classifyReportStatus(status: string | null): DocumentStatusSemantics {
  if (status === null) return ACTIVE_OPEN;
  return reportSemanticsByValue.get(normalize(status)) ?? ACTIVE_OPEN;
}

export function isActiveIssueStatus(status: string | null): boolean {
  return classifyIssueStatus(status).activity === 'active';
}

export function isResolvedIssueStatus(status: string | null): boolean {
  return classifyIssueStatus(status).resolution === 'resolved';
}

export function isInactiveOpenIssueStatus(status: string | null): boolean {
  const semantics = classifyIssueStatus(status);
  return semantics.activity === 'inactive' && semantics.resolution === 'open';
}

export function isActiveReportStatus(status: string | null): boolean {
  return classifyReportStatus(status).activity === 'active';
}

/** Pure side-effect plan for a status change initiated by Iris. */
export function planDocumentStatusTransition(
  type: StatusDocumentType | null,
  status: string,
  autoCheckTodosOnDone: boolean,
): StatusTransitionPlan {
  const semantics = type === 'issue'
    ? classifyIssueStatus(status)
    : type === 'report'
      ? classifyReportStatus(status)
      : null;
  return {
    closeSessions: semantics?.closeSessionsOnEnter ?? false,
    checkTodos:
      type === 'issue' &&
      (semantics?.completesIssue ?? false) &&
      autoCheckTodosOnDone,
  };
}
