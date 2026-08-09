import { translate } from '@renderer/i18n';
import DOMPurify from 'dompurify';

let initialized = false;
let renderSequence = 0;
const purifier = DOMPurify(window);

export function renderMermaidPreview(
  language: string,
  source: string,
  applyPreview: (value: null | string | HTMLElement) => void,
): void | null {
  if (language.trim().toLowerCase() !== 'mermaid') return null;

  void import('mermaid')
    .then(async ({ default: mermaid }) => {
      if (!initialized) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: 'base',
          fontFamily: 'inherit',
        });
        initialized = true;
      }
      const id = `iris-mermaid-${Date.now()}-${renderSequence++}`;
      const { svg, bindFunctions } = await mermaid.render(id, source);
      const container = document.createElement('div');
      container.className = 'mermaid-preview';
      container.innerHTML = purifier.sanitize(svg, {
        // Mermaid uses sanitized HTML labels inside SVG foreignObject nodes.
        // DOMPurify's default profile keeps HTML + SVG but excludes that one
        // integration tag, so opt it in without admitting scripts or handlers.
        ADD_TAGS: ['foreignObject'],
        HTML_INTEGRATION_POINTS: { foreignobject: true },
      });
      applyPreview(container);
      bindFunctions?.(container);
    })
    .catch((error: unknown) => {
      const container = document.createElement('div');
      container.className = 'mermaid-preview mermaid-preview-error';
      const message = error instanceof Error ? error.message.split('\n')[0] : translate('common.unknownError');
      container.textContent = translate('editor.mermaidFailed', { error: message });
      applyPreview(container);
    });

  // `undefined` makes Milkdown install previewLoading. Submit the final value
  // only once: Vue refs ignore a later applyPreview call with the same element
  // identity, and Milkdown sanitizes/copies elements instead of mounting them.
}
