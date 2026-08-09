import { describe, expect, it } from 'vitest';
import {
  checkAllTaskCheckboxes,
  extractTodos,
  getFrontmatterKey,
  setFrontmatterKey,
  setFrontmatterRawKey,
  slugify,
  splitFrontmatter,
  yamlScalar,
} from './markdown-utils';

describe('splitFrontmatter', () => {
  it('raw === fmBlock + body, always', () => {
    const cases = [
      '---\ntitle: a\n---\nbody\n',
      '---\ntitle: a\n---\n',
      'no frontmatter\n',
      '---\nbroken: [yaml\n---\nbody',
      '',
    ];
    for (const raw of cases) {
      const { fmBlock, body } = splitFrontmatter(raw);
      expect(fmBlock + body).toBe(raw);
    }
  });

  it('handles CRLF fences', () => {
    const raw = '---\r\ntitle: a\r\n---\r\nbody';
    const { fmBlock, body } = splitFrontmatter(raw);
    expect(body).toBe('body');
    expect(fmBlock + body).toBe(raw);
  });
});

describe('setFrontmatterKey', () => {
  it('replaces only the target line, byte-preserving the rest', () => {
    const fm = '---\ntitle: 服务边界设计\nstatus: todo\nreflects: a1b3c2 # stamp\n---\n';
    const out = setFrontmatterKey(fm, 'status', 'in_progress');
    expect(out).toBe('---\ntitle: 服务边界设计\nstatus: in_progress\nreflects: a1b3c2 # stamp\n---\n');
  });

  it('inserts a missing key before the closing fence', () => {
    const fm = '---\ntitle: x\n---\n';
    expect(setFrontmatterKey(fm, 'status', 'todo')).toBe('---\ntitle: x\nstatus: todo\n---\n');
  });

  it('creates a block from nothing', () => {
    expect(setFrontmatterKey('', 'title', 'hello')).toBe('---\ntitle: hello\n---\n');
  });

  it('quotes values that need it', () => {
    expect(setFrontmatterKey('', 'title', 'a: b')).toBe('---\ntitle: "a: b"\n---\n');
    expect(yamlScalar('等待外部依赖')).toBe('等待外部依赖');
  });

  it('does not touch nested keys with the same name', () => {
    const fm = '---\nmeta:\n  status: nested\nstatus: todo\n---\n';
    const out = setFrontmatterKey(fm, 'status', 'done');
    expect(out).toContain('  status: nested');
    expect(out).toContain('\nstatus: done');
  });

  it('leaves a malformed block untouched', () => {
    const fm = '---\ntitle: x\n'; // no closing fence
    expect(setFrontmatterKey(fm, 'status', 'todo')).toBe(fm);
  });
});

describe('getFrontmatterKey', () => {
  it('reads plain and quoted scalars', () => {
    expect(getFrontmatterKey('---\nstatus: todo\n---\n', 'status')).toBe('todo');
    expect(getFrontmatterKey('---\ntitle: "a: b"\n---\n', 'title')).toBe('a: b');
    expect(getFrontmatterKey('---\ntitle: x\n---\n', 'status')).toBeNull();
  });
});

describe('setFrontmatterRawKey', () => {
  it('writes a preformatted value as a single key line', () => {
    const fm = '---\ntitle: x\n---\n';
    expect(setFrontmatterRawKey(fm, 'owners', '[alice, bob]'))
      .toBe('---\ntitle: x\nowners: [alice, bob]\n---\n');
  });

  it('replaces a multiline YAML value without leaving orphaned child lines', () => {
    const fm = '---\ntitle: x\nowners:\n  - alice\n  - bob\n\nstatus: Todo\n---\n';
    expect(setFrontmatterRawKey(fm, 'owners', '[]')).toBe(
      '---\ntitle: x\nowners: []\n\nstatus: Todo\n---\n',
    );
  });

  it('preserves CRLF while replacing a multiline YAML value', () => {
    const fm = '---\r\ntitle: x\r\nowners:\r\n  - alice\r\nstatus: Todo\r\n---\r\n';
    expect(setFrontmatterRawKey(fm, 'owners', '[]')).toBe(
      '---\r\ntitle: x\r\nowners: []\r\nstatus: Todo\r\n---\r\n',
    );
  });
});

describe('extractTodos', () => {
  it('extracts bullet and ordered tasks with full-file line numbers', () => {
    const raw = '---\ntitle: x\n---\n\n- [ ] one\n- [x] two\n1. [ ] three\n';
    const todos = extractTodos(raw);
    expect(todos).toEqual([
      { line: 4, checked: false, text: 'one', raw: '- [ ] one' },
      { line: 5, checked: true, text: 'two', raw: '- [x] two' },
      { line: 6, checked: false, text: 'three', raw: '1. [ ] three' },
    ]);
    // the line numbers index into the raw text's own line split
    expect(raw.split(/\r?\n/)[todos[0]!.line]).toBe(todos[0]!.raw);
  });

  it('skips tasks inside fenced code (matching fence char and length)', () => {
    const raw = '- [ ] real\n```md\n- [ ] fake\n~~~\n- [ ] still fake\n```\n- [ ] real again\n';
    expect(extractTodos(raw).map((t) => t.text)).toEqual(['real', 'real again']);
  });

  it('ignores empty tasks and plain list items, keeps nested ones', () => {
    const raw = '- [ ]\n- plain\n  - [ ] nested\n';
    const todos = extractTodos(raw);
    expect(todos).toEqual([{ line: 2, checked: false, text: 'nested', raw: '  - [ ] nested' }]);
  });

  it('handles CRLF and docs without frontmatter', () => {
    const todos = extractTodos('# t\r\n- [X] caps\r\n');
    expect(todos).toEqual([{ line: 1, checked: true, text: 'caps', raw: '- [X] caps' }]);
  });
});

describe('checkAllTaskCheckboxes', () => {
  it('checks bullet, ordered, nested, and empty tasks while preserving line endings', () => {
    const raw = '---\r\ntitle: x\r\n---\r\n- [ ] one\r\n1) [ ] two\r\n  * [ ]\r\n- [x] done\r\n';
    expect(checkAllTaskCheckboxes(raw)).toBe(
      '---\r\ntitle: x\r\n---\r\n- [x] one\r\n1) [x] two\r\n  * [x]\r\n- [x] done\r\n',
    );
  });

  it('leaves task examples inside fenced code unchanged', () => {
    const raw = '- [ ] real\n```md\n- [ ] example\n```\n- [ ] real again\n';
    expect(checkAllTaskCheckboxes(raw)).toBe(
      '- [x] real\n```md\n- [ ] example\n```\n- [x] real again\n',
    );
  });
});

describe('slugify', () => {
  it('keeps CJK, collapses separators, strips fs-illegal chars', () => {
    expect(slugify('鉴权中间件重构')).toBe('鉴权中间件重构');
    expect(slugify('auth refactor: phase 2')).toBe('auth-refactor-phase-2');
    expect(slugify('  ')).toBe('untitled');
  });
});
