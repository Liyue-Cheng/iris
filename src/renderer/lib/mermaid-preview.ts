let initialized = false;
let renderSequence = 0;

export function renderMermaidPreview(
  language: string,
  source: string,
  applyPreview: (value: null | string | HTMLElement) => void,
): null {
  if (language.trim().toLowerCase() !== 'mermaid') return null;

  const container = document.createElement('div');
  container.className = 'mermaid-preview';
  container.textContent = '图表渲染中…';
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
      container.innerHTML = svg;
      bindFunctions?.(container);
    })
    .catch((error: unknown) => {
      container.classList.add('mermaid-preview-error');
      const message = error instanceof Error ? error.message.split('\n')[0] : '未知语法错误';
      container.textContent = `Mermaid 渲染失败：${message}`;
    });

  return null;
}
