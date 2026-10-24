// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { imageBlockComponent, imageBlockConfig, imageBlockSchema } from '@milkdown/kit/component/image-block';
import { imageInlineComponent, inlineImageConfig } from '@milkdown/kit/component/image-inline';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import { resolveMarkdownImage } from './markdown-media';

const docPath = '.iris/issue/测试 文档.md';
const source = './%E6%B5%8B%E8%AF%95%20%E6%96%87%E6%A1%A3.assets/photo.jpg';
const imageUrl = 'data:image/jpeg;base64,aW1hZ2U=';
const editors: Editor[] = [];

async function mount(markdown: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = Editor.make().config((ctx) => {
    ctx.set(rootCtx, root);
    ctx.set(defaultValueCtx, markdown);
    ctx.update(imageBlockConfig.key, (config) => ({
      ...config, proxyDomURL: (src) => resolveMarkdownImage(docPath, src),
    }));
    ctx.update(inlineImageConfig.key, (config) => ({
      ...config, proxyDomURL: (src) => resolveMarkdownImage(docPath, src),
    }));
  }).use(commonmark).use(imageBlockComponent).use(imageInlineComponent);
  editors.push(editor);
  await editor.create();
  return { editor, root };
}

afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.replaceChildren();
  projectScopeState.set(null);
  Reflect.deleteProperty(window, 'api');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Markdown image reopen', () => {
  it.each(['', '图片标题'])('retains an imported image with caption %j when serialized and mounted again', async (caption) => {
    projectScopeState.set({ root: 'C:/project', generation: 1 });
    Object.defineProperty(window, 'api', { configurable: true, value: {
      invoke: vi.fn(async () => ({ dataUrl: imageUrl, error: null })),
    } });
    const errors = vi.spyOn(console, 'error');
    const first = await mount('before');
    first.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const node = imageBlockSchema.type(ctx).create({ src: source, caption, ratio: 0.75 });
      view.dispatch(view.state.tr.insert(view.state.doc.content.size, node));
    });
    await vi.waitFor(() => expect(first.root.querySelector('img')?.getAttribute('src')).toBe(imageUrl));
    const saved = first.editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
    expect(saved).toContain(source);
    expect(saved).not.toContain('data:');
    await first.editor.destroy();
    editors.splice(editors.indexOf(first.editor), 1);
    const reopened = await mount(saved);
    await vi.waitFor(() => expect(reopened.root.querySelector('img')?.getAttribute('src')).toBe(imageUrl));
    reopened.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      expect(view.state.doc.lastChild?.attrs).toMatchObject({ src: source, caption, ratio: 0.75 });
      view.dispatch(view.state.tr.insertText('edited ', 1));
    });
    const resaved = reopened.editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
    expect(resaved).toContain(source);
    expect(resaved).not.toContain('data:');
    expect(errors).not.toHaveBeenCalled();
  });

  it('renders existing titleless block and inline images together', async () => {
    projectScopeState.set({ root: 'C:/project', generation: 1 });
    Object.defineProperty(window, 'api', { configurable: true, value: {
      invoke: vi.fn(async () => ({ dataUrl: imageUrl, error: null })),
    } });
    const errors = vi.spyOn(console, 'error');
    const { editor, root } = await mount(`![1.00](${source})\n\ntext ![inline](${source}) text\n`);
    await vi.waitFor(() => {
      const images = [...root.querySelectorAll('img')];
      expect(images).toHaveLength(2);
      expect(images.every((image) => image.getAttribute('src') === imageUrl)).toBe(true);
    });
    const saved = editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
    expect(saved.split(source)).toHaveLength(3);
    expect(errors).not.toHaveBeenCalled();
  });
});
