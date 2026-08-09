import { describe, expect, it } from 'vitest';
import { ISSUE_STATUSES, REPORT_STATUSES } from '@shared/document-status';
import { DOC_TYPES } from '@shared/types';
import { FOCUS_CONTEXT_SCRIPT } from './agent-injection';
import { initializeMainI18n, mainT } from './i18n';
import { SOFTWARE_PROMPT_TEMPLATE } from './iris-templates';
import { docSkeleton } from './software-prompt';

const WRITABLE_FRONTMATTER_KEYS = ['title:', 'status:', 'reflects:'] as const;
const PROTOCOL_TAGS = [
  '<iris-software>',
  '<iris-project>',
  '<iris-focus>',
  '<iris-workspace>',
] as const;
const ENVIRONMENT_KEYS = ['FOCUS_DOC', 'IRIS_WORKSPACE_PATH'] as const;

describe('i18n protocol boundary', () => {
  it('keeps parser-sensitive vocabulary canonical', () => {
    expect(DOC_TYPES).toEqual(['status', 'issue', 'report', 'misc']);
    expect(ISSUE_STATUSES).toEqual([
      'Todo',
      'In Progress',
      'In Review',
      'Blocked',
      'Done',
      'Canceled',
    ]);
    expect(REPORT_STATUSES).toEqual(['Active', 'Backlog']);
    expect(WRITABLE_FRONTMATTER_KEYS).toEqual(['title:', 'status:', 'reflects:']);
    expect(SOFTWARE_PROMPT_TEMPLATE).toContain('`labels:` frontmatter field is reserved');
    expect(PROTOCOL_TAGS).toEqual([
      '<iris-software>',
      '<iris-project>',
      '<iris-focus>',
      '<iris-workspace>',
    ]);
    expect(ENVIRONMENT_KEYS).toEqual(['FOCUS_DOC', 'IRIS_WORKSPACE_PATH']);
  });

  it('keeps generated document and agent protocol bytes locale-independent', async () => {
    await initializeMainI18n('zh-CN', 'zh-CN');
    const chineseLocaleOutput = {
      issue: docSkeleton('issue', '中英 Mixed title'),
      report: docSkeleton('report', 'Report title'),
      status: docSkeleton('status', 'Current truth'),
      softwarePrompt: SOFTWARE_PROMPT_TEMPLATE,
      focusScript: FOCUS_CONTEXT_SCRIPT,
    };

    await initializeMainI18n('en-US', 'en-US');
    const englishLocaleOutput = {
      issue: docSkeleton('issue', '中英 Mixed title'),
      report: docSkeleton('report', 'Report title'),
      status: docSkeleton('status', 'Current truth'),
      softwarePrompt: SOFTWARE_PROMPT_TEMPLATE,
      focusScript: FOCUS_CONTEXT_SCRIPT,
    };

    expect(englishLocaleOutput).toEqual(chineseLocaleOutput);
    expect(englishLocaleOutput.issue).toContain('status: Todo');
    expect(englishLocaleOutput.report).toContain('status: Active');
    expect(englishLocaleOutput.status).toContain('reflects:');
    expect(englishLocaleOutput.focusScript).toContain('FOCUS_DOC');
    expect(englishLocaleOutput.focusScript).toContain('<iris-focus');
    expect(englishLocaleOutput.focusScript).toContain('<iris-workspace');
  });

  it('localizes user-facing errors while preserving technical parameters', async () => {
    await initializeMainI18n('zh-CN', 'en-US');
    const zh = mainT('error.ptySpawnFailed', {
      shellPath: 'C:\\shell.exe',
      agentId: 'codex',
      cwd: 'E:\\project',
      error: 'ENOENT',
    });
    await initializeMainI18n('en-US', 'zh-CN');
    const en = mainT('error.ptySpawnFailed', {
      shellPath: 'C:\\shell.exe',
      agentId: 'codex',
      cwd: 'E:\\project',
      error: 'ENOENT',
    });

    expect(zh).not.toBe(en);
    for (const value of ['C:\\shell.exe', 'codex', 'E:\\project', 'ENOENT']) {
      expect(zh).toContain(value);
      expect(en).toContain(value);
    }
  });
});
