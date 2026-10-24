// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import { safeHtmlView, safeHtmlDecorations } from './safe-html';
import { stableCodeBlockView } from './stable-code-block';

const source = `# 渲染回归

1. **注意力面板（最有价值）**：把全项目所有活着的会话按状态汇总。
2. **「主线 + 按需详情」的右栏**：右栏顶部用面包屑。
3. **面板头和面板底的统一约定**：显示 agent、\`FOCUS_DOC\`、状态。
4. **卡片化的关联对象**：显示小卡片。
5. **视觉减重**：
   - 左栏头部现在一排 8 个左右的图标。
   - 正文限宽，面板间少用分隔线，多用留白。

- [ ] 待验证
- [x] 已验证

> 引用 *强调* ~~删除~~ [链接](https://example.com)

| 表头 | 另一列 |
| --- | --- |
| 内容 | 值 |

\`\`\`ts
const value = true;
\`\`\`

![图片](./sample.png)

<details open><summary>展开</summary>HTML 内容</details>

快捷键 <kbd>Ctrl</kbd> 和 <mark>标记</mark>。

公式 $a+b$。
`;

it('renders content with the actual Crepe feature stack and retains it after editing and reopening', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  const text: string[] = [];
  let lists = 0;
  interface MarkdownNode { type: string; value?: string; children?: MarkdownNode[] }
  const walk = (node: MarkdownNode) => {
    // Crepe's math plugin renders this paragraph through KaTeX instead.
    if ((node.type === 'text' || node.type === 'inlineCode') && !node.value?.includes('$')) text.push(node.value!);
    if (node.type === 'listItem') lists++;
    node.children?.forEach(walk);
  };
  walk(remark().use(remarkGfm).parse(source));
  const errors = vi.spyOn(console, 'error');
  const root = document.createElement('div');
  document.body.append(root);
  const editors: Crepe[] = [];
  const mount = async (markdown: string) => {
    const crepe = new Crepe({root, defaultValue: markdown, features: {[Crepe.Feature.AI]: false, [Crepe.Feature.BlockEdit]: false}});
    crepe.editor.use(safeHtmlView).use(safeHtmlDecorations);
    crepe.editor.use(stableCodeBlockView);
    editors.push(crepe);
    await crepe.create();
    return crepe;
  };
  const verify = async () => {
    await vi.waitFor(() => {
      for (const value of text) expect(root.textContent).toContain(value);
      expect(root.querySelectorAll('.milkdown-list-item-block')).toHaveLength(lists);
      expect(root.querySelector('img')?.getAttribute('src')).toBe('./sample.png');
      expect(root.querySelector('details')?.textContent).toBe('展开HTML 内容');
      expect(root.querySelector('kbd')?.textContent).toBe('Ctrl');
      expect(root.querySelector('mark')?.textContent).toBe('标记');
      expect(root.querySelector('.katex-mathml annotation')?.textContent).toBe('a+b');
    });
  };
  try {
    const crepe = await mount(source);
    await verify();
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText('编辑 ', 1));
      view.state.doc.check();
    });
    const saved = crepe.getMarkdown();
    await crepe.destroy();
    editors.pop();
    const reopened = await mount(saved);
    await verify();
    expect(root.textContent).toContain('编辑');
    reopened.editor.action((ctx) => ctx.get(editorViewCtx).state.doc.check());
    expect(errors).not.toHaveBeenCalled();
  } finally {
    for (const crepe of editors) await crepe.destroy();
    root.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
