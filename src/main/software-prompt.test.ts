import { describe, expect, it } from 'vitest';
import { ISSUE_STATUSES, REPORT_STATUSES } from '@shared/document-status';
import { SOFTWARE_PROMPT_TEMPLATE } from './iris-templates';
import {
  buildSoftwareBlock,
  classifySoftwareBlock,
  docSkeleton,
  parseProjectBlock,
  parseProjectBlocks,
  parseSoftwareBlock,
  upsertProjectBlock,
  upsertSoftwareBlock,
} from './software-prompt';

describe('software prompt block', () => {
  it('builds an attribute-free block whose exact body is current', () => {
    const block = buildSoftwareBlock();
    expect(block.startsWith('<iris-software>\n')).toBe(true);
    expect(block).not.toMatch(/<iris-software\s+[^>]+>/);
    expect(parseSoftwareBlock(block)?.body).toContain('Folder semantics');
    expect(classifySoftwareBlock(block)).toEqual({ state: 'ok' });
  });

  it('treats any disk body edit as drift', () => {
    const edited = buildSoftwareBlock().replace('Folder semantics', 'Folder semanticz');
    expect(classifySoftwareBlock(edited)).toEqual({ state: 'drifted' });
    expect(classifySoftwareBlock('# prose\n')).toEqual({ state: 'missing' });
    const legacyAttrs = buildSoftwareBlock().replace(
      '<iris-software>',
      '<iris-software version="old" protocol="2" sha="deadbeef">',
    );
    expect(classifySoftwareBlock(legacyAttrs)).toEqual({ state: 'drifted' });
    expect(upsertSoftwareBlock(legacyAttrs).text).toBe(buildSoftwareBlock());
  });

  it('upserts idempotently while preserving surrounding content', () => {
    const source = '# My project\n\nhand-written\n';
    const once = upsertSoftwareBlock(source);
    expect(once.action).toBe('created');
    expect(once.text.startsWith(source)).toBe(true);
    const twice = upsertSoftwareBlock(once.text);
    expect(twice).toEqual({ text: once.text, action: 'unchanged' });

    const drifted = once.text.replace('Folder semantics', 'Changed by hand');
    const restored = upsertSoftwareBlock(drifted);
    expect(restored.action).toBe('updated');
    expect(restored.text.startsWith(source)).toBe(true);
    expect(classifySoftwareBlock(restored.text).state).toBe('ok');
  });
});

describe('project prompt block', () => {
  it('ignores tag-shaped prose that is not a standalone managed block', () => {
    const source = 'Do not edit `<iris-project>` blocks.\n';
    expect(parseProjectBlock(source)).toBeNull();
    expect(parseProjectBlock(upsertProjectBlock(source, 'Rule').text)?.body).toBe('Rule');
  });

  it('creates, updates, and removes the block without touching user prose', () => {
    const source = '# Entry\n\nuser prose\n';
    const created = upsertProjectBlock(source, 'First rule');
    expect(created.action).toBe('created');
    expect(parseProjectBlock(created.text)?.body).toBe('First rule');
    expect(created.text.startsWith(source)).toBe(true);

    const attributed = created.text.replace(
      '<iris-project>',
      '<iris-project path="legacy">',
    );
    const normalized = upsertProjectBlock(attributed, 'First rule');
    expect(normalized.action).toBe('updated');
    expect(normalized.text).not.toContain('path="legacy"');

    const updated = upsertProjectBlock(normalized.text, 'Second rule\r\n');
    expect(updated.action).toBe('updated');
    expect(parseProjectBlock(updated.text)?.body).toBe('Second rule');
    expect(updated.text.startsWith(source)).toBe(true);

    const removed = upsertProjectBlock(updated.text, '');
    expect(removed.action).toBe('removed');
    expect(parseProjectBlock(removed.text)).toBeNull();
    expect(removed.text).toBe(source);
  });

  it('reports duplicate blocks instead of updating only one copy', () => {
    const source = '<iris-project>\nOne\n</iris-project>\n<iris-project>\nTwo\n</iris-project>\n';
    expect(parseProjectBlocks(source).map((block) => block.body)).toEqual(['One', 'Two']);
    expect(() => upsertProjectBlock(source, 'Canonical')).toThrow('Multiple <iris-project> blocks');
  });
});

describe('software prompt invariants', () => {
  it('owns state-machine, checkbox, markdown, and static-context behavior', () => {
    expect(ISSUE_STATUSES).toEqual([
      'Todo',
      'In Progress',
      'In Review',
      'Blocked',
      'On Hold',
      'Done',
      'Canceled',
    ]);
    expect(REPORT_STATUSES).toEqual(['Active', 'Backlog']);
    for (const status of [...ISSUE_STATUSES, ...REPORT_STATUSES]) {
      expect(SOFTWARE_PROMPT_TEMPLATE).toContain(`\`${status}\``);
    }
    expect(SOFTWARE_PROMPT_TEMPLATE).toContain('GFM task checkbox');
    expect(SOFTWARE_PROMPT_TEMPLATE).toContain('Write plain CommonMark');
    expect(SOFTWARE_PROMPT_TEMPLATE).toContain('<name>.assets/');
    expect(SOFTWARE_PROMPT_TEMPLATE).toContain('Never delete an asset merely because');
    expect(SOFTWARE_PROMPT_TEMPLATE).toContain('entry file');
    expect(SOFTWARE_PROMPT_TEMPLATE).toContain(
      'The `labels:` frontmatter field is reserved and is not currently enabled.',
    );
    expect(SOFTWARE_PROMPT_TEMPLATE).toContain('Do not add, populate, edit, normalize, or remove it');
    expect(SOFTWARE_PROMPT_TEMPLATE).toContain('Preserve an existing valid');
    expect(SOFTWARE_PROMPT_TEMPLATE).not.toContain('feeds the filter chips');
    expect(SOFTWARE_PROMPT_TEMPLATE).not.toContain('iris-user');
    expect(SOFTWARE_PROMPT_TEMPLATE).not.toContain('~/.iris/CONVENTIONS.md');
  });

  it('keeps new-document skeletons aligned with the prompt', () => {
    expect(docSkeleton('issue', 'x')).toBe('---\ntitle: x\nstatus: Todo\n---\n');
    expect(docSkeleton('report', 'x')).toBe('---\ntitle: x\nstatus: Active\n---\n');
    expect(docSkeleton('status', 'x')).toBe('---\ntitle: x\nreflects:\n---\n');
    expect(docSkeleton('misc', 'x')).toBe('---\ntitle: x\n---\n');
  });
});
