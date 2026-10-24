// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { DOMParser, DOMSerializer } from '@milkdown/kit/prose/model';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';

const editors: Editor[] = [];

async function mount(markdown: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = Editor.make().config((ctx) => {
    ctx.set(rootCtx, root);
    ctx.set(defaultValueCtx, markdown);
  }).use(commonmark).use(gfm);
  editors.push(editor);
  await editor.create();
  return { editor, root };
}

afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('Markdown content preservation', () => {
  it('renders ordered, nested bullet and task list content and retains it on reopen', async () => {
    const errors = vi.spyOn(console, 'error');
    const source = `1. **注意力面板（最有价值）**：把全项目所有活着的会话按状态汇总。
2. **「主线 + 按需详情」的右栏**：右栏顶部用面包屑。
3. **面板头和面板底的统一约定**：显示 agent、\`FOCUS_DOC\`、状态。
4. **卡片化的关联对象**：显示小卡片。
5. **视觉减重**：
   - 左栏头部现在一排 8 个左右的图标。
   - 正文限宽，面板间少用分隔线，多用留白。

- [ ] 待验证
- [x] 已验证
`;
    const { editor, root } = await mount(source);
    expect(root.textContent).toContain('注意力面板（最有价值）');
    expect(root.querySelectorAll('li')).toHaveLength(9);
    expect(root.textContent).toContain('正文限宽');
    expect(root.textContent).toContain('待验证');
    const saved = editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
    const reopened = await mount(saved);
    expect(reopened.root.textContent).toBe(root.textContent);
    expect(reopened.root.querySelectorAll('li')).toHaveLength(9);
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    '- first\n- second\n',
    '- first\n\n- second\n',
    '3. first\n4. second\n',
    '3. first\n\n4. second\n',
    '- [ ] first\n- [x] second\n',
    '- [ ] first\n\n- [x] second\n',
    '- outer\n  - inner\n\n    continuation\n',
  ])('preserves list structure, spacing and checked state through Markdown and HTML: %j', async (source) => {
    const errors = vi.spyOn(console, 'error');
    const { editor } = await mount(source);
    // Compare semantic MDAST, including spread and start, ignoring source positions.
    const ast = (markdown: string): unknown => JSON.parse(JSON.stringify(
      remark().use(remarkGfm).parse(markdown), (key, value) => key === 'position' ? undefined : value,
    ));
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const serialize = ctx.get(serializerCtx);
      expect(ast(serialize(view.state.doc))).toEqual(ast(source));
      const dom = document.createElement('div');
      dom.append(DOMSerializer.fromSchema(view.state.schema).serializeFragment(view.state.doc.content));
      const pasted = DOMParser.fromSchema(view.state.schema).parse(dom);
      expect(ast(serialize(pasted))).toEqual(ast(source));
      // Actual editor transactions must keep working with the compatibility schema.
      view.dispatch(view.state.tr.insertText('edited ', 3));
      expect(serialize(view.state.doc)).toContain('edited');
      view.state.doc.check();
    });
    expect(errors).not.toHaveBeenCalled();
  });

  it('keeps headings, marks, links, quotes, tables, code, HTML and footnotes around lists', async () => {
    const errors = vi.spyOn(console, 'error');
    const source = '# heading\n\n**bold** *italic* ~~deleted~~ `inline` [link](https://example.com)\n\n'
      + '> quote\n>\n> - quoted item\n\n---\n\n'
      + '| column | other |\n| --- | --- |\n| cell | value |\n\n'
      + '```\nplain code\n```\n\n```ts\nconst typed = true;\n```\n\n'
      + '<details open><summary>summary</summary>detail</details>\n\n'
      + 'footnote[^note]\n\n[^note]: note text\n';
    const { editor, root } = await mount(source);
    for (const text of ['heading', 'bold', 'italic', 'deleted', 'inline', 'link', 'quote', 'quoted item', 'column', 'cell', 'plain code', 'const typed', 'summary', 'note text']) {
      expect(root.textContent).toContain(text);
    }
    const saved = editor.action((ctx) => {
      const doc = ctx.get(editorViewCtx).state.doc;
      doc.check();
      return ctx.get(serializerCtx)(doc);
    });
    const reopened = await mount(saved);
    expect(reopened.root.textContent).toBe(root.textContent);
    expect(errors).not.toHaveBeenCalled();
  });
});
