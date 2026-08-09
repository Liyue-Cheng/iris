/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock('mermaid', () => ({ default: mermaidMock }));
vi.mock('@renderer/i18n', () => ({
  translate: (key: string, values?: { error?: string }) =>
    key === 'editor.mermaidFailed' ? `Mermaid failed: ${values?.error ?? ''}` : key,
}));

import { renderMermaidPreview } from './mermaid-preview';

describe('Mermaid preview', () => {
  beforeEach(() => {
    mermaidMock.render.mockReset();
  });

  it('returns the async-preview sentinel and installs sanitized SVG', async () => {
    mermaidMock.render.mockResolvedValue({
      svg: '<svg><style>.label{font-weight:600}</style><foreignObject><div class="label">Diagram</div></foreignObject><script>alert(1)</script></svg>',
      bindFunctions: vi.fn(),
    });
    const preview: { current: HTMLElement | null } = { current: null };

    const result = renderMermaidPreview('mermaid', 'flowchart LR\nA-->B', (value) => {
      preview.current = value instanceof HTMLElement ? value : null;
    });

    expect(result).toBeUndefined();
    await vi.waitFor(() => expect(preview.current?.textContent).toContain('Diagram'));
    expect(preview.current?.querySelector('foreignObject')).not.toBeNull();
    expect(preview.current?.querySelector('style')).not.toBeNull();
    expect(preview.current?.querySelector('script')).toBeNull();
  });

  it('returns null for other code block languages', () => {
    const applyPreview = vi.fn();
    expect(renderMermaidPreview('typescript', 'const value = 1', applyPreview)).toBeNull();
    expect(applyPreview).not.toHaveBeenCalled();
  });

  it('keeps a readable fallback when Mermaid rejects invalid syntax', async () => {
    mermaidMock.render.mockRejectedValue(new Error('Parse error on line 1\nDetails'));
    const preview: { current: HTMLElement | null } = { current: null };

    renderMermaidPreview('mermaid', 'invalid', (value) => {
      preview.current = value instanceof HTMLElement ? value : null;
    });

    await vi.waitFor(() =>
      expect(preview.current?.classList.contains('mermaid-preview-error')).toBe(true),
    );
    expect(preview.current?.textContent).toContain('Parse error on line 1');
  });
});
