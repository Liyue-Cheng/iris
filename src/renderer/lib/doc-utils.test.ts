import { describe, expect, it } from 'vitest';
import { shouldShowLensStatusBadge } from './doc-utils';

describe('lens status badges', () => {
  it('hides Active for non-issue documents because the lens already filters to active', () => {
    expect(
      shouldShowLensStatusBadge({ type: 'report', status: 'Active', frontmatterBroken: false }),
    ).toBe(false);
    expect(
      shouldShowLensStatusBadge({ type: 'status', status: ' active ', frontmatterBroken: false }),
    ).toBe(false);
    expect(
      shouldShowLensStatusBadge({ type: 'misc', status: 'Backlog', frontmatterBroken: false }),
    ).toBe(true);
  });

  it('keeps issue statuses and exceptional values visible', () => {
    expect(
      shouldShowLensStatusBadge({ type: 'issue', status: 'In Progress', frontmatterBroken: false }),
    ).toBe(true);
    expect(
      shouldShowLensStatusBadge({ type: 'report', status: 'Custom', frontmatterBroken: false }),
    ).toBe(true);
    expect(
      shouldShowLensStatusBadge({ type: 'report', status: null, frontmatterBroken: false }),
    ).toBe(false);
    expect(
      shouldShowLensStatusBadge({ type: 'report', status: 'Active', frontmatterBroken: true }),
    ).toBe(false);
  });
});
