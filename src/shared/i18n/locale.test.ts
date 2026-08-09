import { describe, expect, it } from 'vitest';
import { ISSUE_STATUSES, REPORT_STATUSES } from '../document-status';
import { normalizeSystemLocale, resolveLocale } from './locale';
import { enUS, zhCN } from './resources';

function keys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('application locales', () => {
  it('resolves Chinese system locales and falls back to English', () => {
    expect(normalizeSystemLocale('zh-TW')).toBe('zh-CN');
    expect(normalizeSystemLocale('en-GB')).toBe('en-US');
    expect(resolveLocale('en-US', 'zh-CN')).toBe('en-US');
    expect(resolveLocale('system', 'zh-CN')).toBe('zh-CN');
  });

  it('keeps both catalogs structurally aligned', () => {
    expect(keys(zhCN).sort()).toEqual(keys(enUS).sort());
  });

  it('keeps parser-sensitive document statuses canonical', () => {
    expect(ISSUE_STATUSES).toEqual([
      'Todo',
      'In Progress',
      'In Review',
      'Blocked',
      'Done',
      'Canceled',
    ]);
    expect(REPORT_STATUSES).toEqual(['Active', 'Backlog']);
  });
});
