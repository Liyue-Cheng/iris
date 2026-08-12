import DOMPurify from 'dompurify';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { Plugin } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { htmlSchema } from '@milkdown/kit/preset/commonmark';
import { $prose, $view } from '@milkdown/kit/utils';

const purifier = DOMPurify(window);

const ALLOWED_TAGS = [
  'abbr',
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'var',
] as const;

const ALLOWED_ATTR = [
  'align',
  'colspan',
  'dir',
  'headers',
  'id',
  'lang',
  'open',
  'rowspan',
  'scope',
  'span',
  'title',
] as const;

const BLOCK_TAGS = new Set([
  'blockquote',
  'details',
  'div',
  'dl',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'ol',
  'p',
  'pre',
  'table',
  'ul',
]);

type InlineHtmlTag = 'kbd' | 'mark';

export interface HtmlBoundary {
  tag: InlineHtmlTag;
  closing: boolean;
}

/** Milkdown represents raw HTML as atom nodes, including paired inline tags. */
export function parseHtmlBoundary(value: string): HtmlBoundary | null {
  const trimmed = value.trim();
  const closing = /^<\/(kbd|mark)\s*>$/i.exec(trimmed);
  if (closing?.[1]) return { tag: closing[1].toLowerCase() as InlineHtmlTag, closing: true };

  const opening = /^<(kbd|mark)(?:\s+[^<>]*)?>$/i.exec(trimmed);
  if (opening?.[1]) return { tag: opening[1].toLowerCase() as InlineHtmlTag, closing: false };
  return null;
}

export function sanitizeHtmlFragment(value: string): DocumentFragment {
  return purifier.sanitize(value, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    ALLOW_ARIA_ATTR: true,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment;
}

function renderHtml(dom: HTMLElement, value: string): void {
  dom.replaceChildren();
  dom.classList.remove('milkdown-html-preview-block', 'milkdown-html-preview-empty');

  if (parseHtmlBoundary(value)) {
    dom.classList.add('milkdown-html-preview-empty');
    return;
  }

  const fragment = sanitizeHtmlFragment(value);
  const firstElement = fragment.firstElementChild;
  if (firstElement && BLOCK_TAGS.has(firstElement.tagName.toLowerCase())) {
    dom.classList.add('milkdown-html-preview-block');
  }
  dom.append(fragment);

  if (!dom.hasChildNodes()) {
    dom.classList.add('milkdown-html-preview-empty');
  }
}

export const safeHtmlView = $view(htmlSchema.node, () => (node) => {
  const dom = document.createElement('span');
  dom.className = 'milkdown-html-preview';
  dom.contentEditable = 'false';
  renderHtml(dom, String(node.attrs.value ?? ''));

  return {
    dom,
    update(updatedNode) {
      if (updatedNode.type !== node.type) return false;
      renderHtml(dom, String(updatedNode.attrs.value ?? ''));
      return true;
    },
    ignoreMutation: () => true,
    stopEvent: () => true,
  };
});

interface OpenBoundary {
  tag: InlineHtmlTag;
  pos: number;
  from: number;
  nodeSize: number;
}

export function createHtmlDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((parent, parentPos) => {
    if (!parent.inlineContent) return;

    const stack: OpenBoundary[] = [];
    parent.forEach((child, offset) => {
      if (child.type.name !== 'html') return;
      const boundary = parseHtmlBoundary(String(child.attrs.value ?? ''));
      if (!boundary) return;

      const pos = parentPos + 1 + offset;
      if (!boundary.closing) {
        stack.push({ tag: boundary.tag, pos, from: pos + child.nodeSize, nodeSize: child.nodeSize });
        return;
      }

      const openIndex = stack.findLastIndex((item) => item.tag === boundary.tag);
      if (openIndex < 0) return;
      const [open] = stack.splice(openIndex, 1);
      if (!open) return;

      decorations.push(
        Decoration.node(open.pos, open.pos + open.nodeSize, {
          class: 'milkdown-html-boundary',
        }),
        Decoration.node(pos, pos + child.nodeSize, { class: 'milkdown-html-boundary' }),
      );
      if (open.from < pos) {
        decorations.push(
          Decoration.inline(open.from, pos, {
            class: `milkdown-html-inline milkdown-html-inline-${boundary.tag}`,
            nodeName: boundary.tag,
          }),
        );
      }
    });
  });

  return DecorationSet.create(doc, decorations);
}

export const safeHtmlDecorations = $prose(
  () =>
    new Plugin({
      props: {
        decorations: (state) => createHtmlDecorations(state.doc),
      },
    }),
);
