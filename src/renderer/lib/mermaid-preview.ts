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

  const container = document.createElement('div');
  container.className = 'mermaid-preview';
  container.textContent = translate('editor.diagramRendering');
  applyPreview(container);

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
      container.replaceChildren();
      container.innerHTML = purifier.sanitize(svg, {
        // Mermaid uses sanitized HTML labels inside SVG foreignObject nodes.
        // DOMPurify's default profile keeps HTML + SVG but excludes that one
        // integration tag, so opt it in without admitting scripts or handlers.
        ADD_TAGS: ['foreignObject'],
        HTML_INTEGRATION_POINTS: { foreignobject: true },
      });
      bindFunctions?.(container);
    })
    .catch((error: unknown) => {
      container.classList.add('mermaid-preview-error');
      const message = error instanceof Error ? error.message.split('\n')[0] : translate('common.unknownError');
      container.textContent = translate('editor.mermaidFailed', { error: message });
    });

  // `undefined` is Milkdown's async-preview contract. Returning `null` here
  // clears the container that was just passed to applyPreview.
}
