/** Canonical document statuses shared by protocol text, creation, and UI. */
export const ISSUE_STATUS = {
  todo: 'Todo',
  inProgress: 'In Progress',
  inReview: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
  canceled: 'Canceled',
} as const;

export const ISSUE_STATUSES = Object.freeze(Object.values(ISSUE_STATUS));

export const REPORT_STATUS = {
  active: 'Active',
  backlog: 'Backlog',
} as const;

export const REPORT_STATUSES = Object.freeze(Object.values(REPORT_STATUS));

export type IssueStatus = (typeof ISSUE_STATUS)[keyof typeof ISSUE_STATUS];
export type ReportStatus = (typeof REPORT_STATUS)[keyof typeof REPORT_STATUS];

