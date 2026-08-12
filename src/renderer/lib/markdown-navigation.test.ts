/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import {
  findFragmentTarget,
  headingSlug,
  headingSlugs,
  resolveMarkdownLink,
  scrollToFragment,
} from './markdown-navigation';

describe('Markdown link resolution', () => {
  const current = '.iris/issue/current.md';

  it('separates external, same-document, and relative document links', () => {
    expect(resolveMarkdownLink(current, 'https://example.com/a?q=1')).toEqual({
      kind: 'external',
      url: 'https://example.com/a?q=1',
    });
    expect(resolveMarkdownLink(current, '#%E6%9F%90%E4%B8%80%E8%8A%82')).toEqual({
      kind: 'document',
      path: current,
      fragment: '某一节',
    });
    expect(resolveMarkdownLink(current, '../report/result.md#summary')).toEqual({
      kind: 'document',
      path: '.iris/report/result.md',
      fragment: 'summary',
    });
    expect(resolveMarkdownLink(current, './other.MD')).toEqual({
      kind: 'document',
      path: '.iris/issue/other.MD',
      fragment: null,
    });
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'mailto:test@example.com',
    '/absolute.md',
    'C:\\secret.md',
    '../../../../outside.md',
    './image.png',
    './other.md?raw=1',
    '#',
    '#%ZZ',
  ])('rejects unsupported or unsafe href %s', (href) => {
    expect(resolveMarkdownLink(current, href)).toEqual({ kind: 'invalid' });
  });
});
describe('Iris heading fragments', () => {
  it('locks Unicode, punctuation, empty, and duplicate slug behavior', () => {
    expect(headingSlug(' 你好，Iris！ ')).toBe('你好iris');
    expect(headingSlug('API & CLI -- Notes')).toBe('api-cli-notes');
    expect(headingSlug('***')).toBe('section');
    expect(headingSlugs(['重复', '重复', '***', '***'])).toEqual([
      '重复',
      '重复-2',
      'section',
      'section-2',
    ]);
  });

  it('finds generated headings and explicit HTML anchors', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <h2>重复</h2><h3>重复</h3>
      <span class="milkdown-html-preview"><a id="manual"></a></span>
    `;

    expect(findFragmentTarget(root, '重复')).toBe(root.querySelector('h2'));
    expect(findFragmentTarget(root, '重复-2')).toBe(root.querySelector('h3'));
    expect(findFragmentTarget(root, 'manual')).toBe(root.querySelector('#manual'));
    expect(findFragmentTarget(root, 'missing')).toBeNull();
  });

  it('scrolls only when a fragment exists', () => {
    const root = document.createElement('div');
    root.innerHTML = '<h2>Target</h2>';
    const heading = root.querySelector('h2')!;
    heading.scrollIntoView = vi.fn();

    expect(scrollToFragment(root, 'target')).toBe(true);
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(scrollToFragment(root, 'missing')).toBe(false);
  });
});
