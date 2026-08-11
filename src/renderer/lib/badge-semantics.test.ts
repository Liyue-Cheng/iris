import { describe, expect, it } from 'vitest';
import { ISSUE_STATUS, REPORT_STATUS } from '@shared/document-status';
import { statusTemplate } from '@renderer/components/ui/status-badge';
import {
  issueColumnWidthsForWidth,
  issueGridLayoutForWidth,
  issueInnerColumnWidthsForColumns,
} from '@renderer/components/collection/parts/layout';

function sumColumns(width: ReturnType<typeof issueColumnWidthsForWidth>): number {
  return width.title + width.status + width.workspace + width.date;
}

describe('badge semantics', () => {
  it('keeps canonical status emphasis product-owned', () => {
    expect(statusTemplate(ISSUE_STATUS.todo)).toEqual({ variant: 'soft', color: 'status-neutral' });
    expect(statusTemplate(ISSUE_STATUS.inProgress)).toEqual({ variant: 'soft', color: 'status-progress' });
    expect(statusTemplate(ISSUE_STATUS.inReview)).toEqual({ variant: 'soft', color: 'status-review' });
    expect(statusTemplate(ISSUE_STATUS.blocked)).toEqual({ variant: 'soft', color: 'status-blocked' });
    expect(statusTemplate(ISSUE_STATUS.onHold)).toEqual({ variant: 'soft', color: 'status-hold' });
    expect(statusTemplate(ISSUE_STATUS.done)).toEqual({ variant: 'soft', color: 'status-done' });
    expect(statusTemplate(ISSUE_STATUS.canceled)).toEqual({ variant: 'soft', color: 'status-neutral' });
    expect(statusTemplate(REPORT_STATUS.active)).toEqual({ variant: 'soft', color: 'status-progress' });
    expect(statusTemplate(REPORT_STATUS.backlog)).toEqual({ variant: 'soft', color: 'status-neutral' });
  });

  it('degrades exceptional statuses to the neutral template', () => {
    expect(statusTemplate('Custom')).toEqual({ variant: 'soft', color: 'status-neutral' });
  });
});

describe('issue list column allocation', () => {
  it('matches the explicit breakpoint model', () => {
    expect(issueColumnWidthsForWidth(0)).toEqual({
      title: 0,
      status: 0,
      workspace: 0,
      date: 0,
    });
    expect(issueColumnWidthsForWidth(298)).toEqual({
      title: 106,
      status: 72,
      workspace: 56,
      date: 64,
    });
    expect(issueColumnWidthsForWidth(330)).toEqual({
      title: 130,
      status: 72,
      workspace: 56,
      date: 72,
    });
    expect(issueColumnWidthsForWidth(490)).toEqual({
      title: 226,
      status: 112,
      workspace: 80,
      date: 72,
    });
    expect(issueColumnWidthsForWidth(720)).toEqual({
      title: 362,
      status: 128,
      workspace: 158,
      date: 72,
    });
    expect(issueColumnWidthsForWidth(850)).toEqual({
      title: 442,
      status: 136,
      workspace: 200,
      date: 72,
    });
  });

  it('interpolates within each segment and gives rounding remainder to title', () => {
    expect(issueColumnWidthsForWidth(410)).toEqual({
      title: 178,
      status: 92,
      workspace: 68,
      date: 72,
    });
    expect(issueColumnWidthsForWidth(605)).toEqual({
      title: 294,
      status: 120,
      workspace: 119,
      date: 72,
    });
    expect(issueColumnWidthsForWidth(785)).toEqual({
      title: 402,
      status: 132,
      workspace: 179,
      date: 72,
    });
  });

  it('preserves all columns and sums exactly to the available width', () => {
    for (const width of [1, 7, 39, 297, 299, 329, 331, 489, 491, 719, 721, 849, 851, 1000]) {
      const columns = issueColumnWidthsForWidth(width);
      expect(Object.values(columns).every((column) => column >= 0)).toBe(true);
      expect(sumColumns(columns)).toBe(width);
    }
  });

  it('caps metadata columns and lets title absorb extra space after 850px', () => {
    expect(issueColumnWidthsForWidth(1000)).toEqual({
      title: 592,
      status: 136,
      workspace: 200,
      date: 72,
    });
  });

  it('centers metadata through shared inner tracks capped by their outer slots', () => {
    const layout = issueGridLayoutForWidth(850, {
      status: 94.2,
      workspace: 128.1,
      date: 61.4,
    });

    expect(layout.inner).toEqual({
      status: 95,
      workspace: 129,
      date: 62,
    });
    expect(layout.titleWidth).toBe(442);
    expect(layout.gridTemplateColumns).toBe(
      'minmax(0, 1fr) 136px 200px 72px',
    );
  });

  it('never lets an inner track exceed its outer column or become negative', () => {
    const outer = issueColumnWidthsForWidth(330);
    expect(
      issueInnerColumnWidthsForColumns(outer, {
        status: 100,
        workspace: Number.POSITIVE_INFINITY,
        date: -10,
      }),
    ).toEqual({
      status: 72,
      workspace: 0,
      date: 0,
    });
  });
});
