/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/kit/prose/model';
import {
  createHtmlDecorations,
  parseHtmlBoundary,
  sanitizeHtmlFragment,
} from './safe-html';

describe('safe HTML rendering', () => {
  it('keeps supported disclosure, inline, and table elements', () => {
    const fragment = sanitizeHtmlFragment(`
      <details open><summary>More</summary><p><kbd>Ctrl</kbd> <mark>marked</mark></p></details>
      <table><thead><tr><th scope="col">Name</th></tr></thead><tbody><tr><td>A</td></tr></tbody></table>
    `);
    const host = document.createElement('div');
    host.append(fragment);

    expect(host.querySelector('details')?.hasAttribute('open')).toBe(true);
    expect(host.querySelector('summary')?.textContent).toBe('More');
    expect(host.querySelector('kbd')?.textContent).toBe('Ctrl');
    expect(host.querySelector('mark')?.textContent).toBe('marked');
    expect(host.querySelector('th')?.getAttribute('scope')).toBe('col');
    expect(host.querySelector('td')?.textContent).toBe('A');
  });

  it('removes executable elements, event attributes, and unapproved embeds', () => {
    const fragment = sanitizeHtmlFragment(`
      <details onclick="globalThis.pwned = true"><summary>Safe</summary></details>
      <script>globalThis.pwned = true</script>
      <iframe src="javascript:alert(1)"></iframe>
      <img src="x" onerror="globalThis.pwned = true">
    `);
    const host = document.createElement('div');
    host.append(fragment);

    expect(host.querySelector('details')?.hasAttribute('onclick')).toBe(false);
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('img')).toBeNull();
  });

  it('keeps explicit anchor ids without allowing HTML links', () => {
    const fragment = sanitizeHtmlFragment(
      '<a id="manual" href="https://example.com" onclick="alert(1)"></a>',
    );
    const host = document.createElement('div');
    host.append(fragment);
    const anchor = host.querySelector('a');

    expect(anchor?.id).toBe('manual');
    expect(anchor?.hasAttribute('href')).toBe(false);
    expect(anchor?.hasAttribute('onclick')).toBe(false);
  });

  it('recognizes paired kbd and mark boundaries', () => {
    expect(parseHtmlBoundary('<kbd title="shortcut">')).toEqual({ tag: 'kbd', closing: false });
    expect(parseHtmlBoundary('</KBD>')).toEqual({ tag: 'kbd', closing: true });
    expect(parseHtmlBoundary('<mark>')).toEqual({ tag: 'mark', closing: false });
    expect(parseHtmlBoundary('<script>')).toBeNull();
  });

  it('wraps content between paired inline HTML atoms', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'paragraph+' },
        paragraph: { content: 'inline*', group: 'block' },
        text: { group: 'inline' },
        html: {
          atom: true,
          attrs: { value: { default: '' } },
          group: 'inline',
          inline: true,
        },
      },
    });
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.node('html', { value: '<kbd>' }),
        schema.text('Ctrl'),
        schema.node('html', { value: '</kbd>' }),
      ]),
    ]);

    const ranges = createHtmlDecorations(doc)
      .find()
      .map(({ from, to }) => [from, to]);
    expect(ranges).toEqual(
      expect.arrayContaining([
        [1, 2],
        [2, 6],
        [6, 7],
      ]),
    );
  });
});
