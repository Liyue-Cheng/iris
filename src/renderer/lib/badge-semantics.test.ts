import { describe, expect, it } from 'vitest';
import { ISSUE_STATUS, REPORT_STATUS } from '@shared/document-status';
import { statusTemplate } from '@renderer/components/ui/status-badge';
import { labelColor } from './label-utils';

describe('badge semantics', () => {
  it('keeps canonical status emphasis product-owned', () => {
    expect(statusTemplate(ISSUE_STATUS.todo)).toEqual({ variant: 'soft', color: 'gray' });
    expect(statusTemplate(ISSUE_STATUS.blocked)).toEqual({ variant: 'soft', color: 'love' });
    expect(statusTemplate(ISSUE_STATUS.done)).toEqual({ variant: 'solid', color: 'pine' });
    expect(statusTemplate(REPORT_STATUS.backlog)).toEqual({ variant: 'dot', color: 'gray' });
  });

  it('degrades exceptional statuses to the neutral template', () => {
    expect(statusTemplate('Custom')).toEqual({ variant: 'soft', color: 'gray' });
  });

  it('maps labels to stable accent colors without stored configuration', () => {
    expect(labelColor('bug')).toBe('gold');
    expect(labelColor('round-3')).toBe('pine');
    expect(labelColor('feature')).toBe('iris');
    expect(labelColor('bug')).toBe(labelColor('bug'));
  });
});
