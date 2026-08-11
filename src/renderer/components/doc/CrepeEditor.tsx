/**
 * Crepe (Milkdown) WYSIWYG body editor. Receives the BODY ONLY — the
 * frontmatter never enters this component (typed header owns it).
 *
 * Lifecycle: one Crepe instance per (path, generation); generation bumps
 * force a clean remount (external reload, mode handover). Right after
 * create() the serialization baseline is captured so "Crepe normalized the
 * markdown on load" is never mistaken for a user edit (editor-store compares
 * against this baseline, and unchanged bodies save as original bytes).
 *
 * AI feature stays off — Iris is a dumb shell; intelligence lives in the
 * user's own agent CLIs (software-definition.md 哑壳).
 *
 * The parent DocView owns the shared edit context menu. This component
 * exposes focus and drop operations through one editor adapter so menu
 * actions return to the preserved ProseMirror selection.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import { languages } from '@codemirror/language-data';
import { rosePineCodeMirror } from '@renderer/styles/codemirror-theme';
import { editorStore } from '@renderer/stores/editor-store';
import { mountCrepeSerially, type CrepeLifecycle } from '@renderer/lib/crepe-lifecycle';
import { useSettings } from '@renderer/stores/settings-store';
import { markImageLoadFailure, resolveMarkdownImage } from '@renderer/lib/markdown-media';
import { renderMermaidPreview } from '@renderer/lib/mermaid-preview';
import { importAsset } from '@renderer/lib/asset-actions';
import { attachScrollMemory, type ScrollMemoryHandle } from '@renderer/lib/scroll-memory';
import {
  attachCodeBlockCopyFeedback,
  stableCodeBlockView,
} from '@renderer/lib/stable-code-block';
import { safeHtmlDecorations, safeHtmlView } from '@renderer/lib/safe-html';
import type { EditorAdapter } from '@renderer/lib/doc-drag';

import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

export function CrepeEditor({
  path,
  generation,
  body,
  onEditorAdapterChange,
}: {
  path: string;
  generation: number;
  body: string;
  onEditorAdapterChange: (adapter: EditorAdapter | null) => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const settings = useSettings();
  const blockEdit = settings?.behavior.editorBlockEdit ?? false;
  const bodyAlign = settings?.behavior.editorBodyAlign ?? 'center';

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    let stopped = false;
    let hydrationFrame: number | null = null;
    let scrollMemory: ScrollMemoryHandle | null = null;
    const detachCopyFeedback = attachCodeBlockCopyFeedback(el);
    const crepe = new Crepe({
      root: el,
      defaultValue: body,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.Latex]: true,
        [Crepe.Feature.BlockEdit]: blockEdit,
      },
      featureConfigs: {
        // Wire CodeMirror's language parsers (without this the feature loads
        // no grammar → code blocks render as monochrome text) and overlay the
        // Rose Pine highlight. `extensions` is appended after basicSetup, so it
        // wins over CodeMirror's light defaultHighlightStyle.
        [Crepe.Feature.CodeMirror]: {
          languages,
          extensions: [rosePineCodeMirror],
          copyText: t('common.copy'),
          renderPreview: renderMermaidPreview,
          previewOnlyByDefault: true,
          previewLabel: t('editor.preview'),
          previewLoading: t('editor.rendering'),
        },
        [Crepe.Feature.ImageBlock]: {
          onUpload: async (file) => (await importAsset(path, file)).markdownUrl,
          proxyDomURL: (source) => resolveMarkdownImage(path, source),
          onImageLoadError: markImageLoadFailure,
          inlineUploadButton: t('editor.upload'),
          blockUploadButton: t('editor.uploadImage'),
          inlineUploadPlaceholderText: t('editor.pasteLink'),
          blockUploadPlaceholderText: t('editor.pasteLink'),
        },
      },
    });
    crepe.editor.use(stableCodeBlockView);
    crepe.editor.use(safeHtmlView).use(safeHtmlDecorations);

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, md) => {
        if (!stopped) editorStore.setBodyFromEditor(path, generation, md);
      });
    });

    const lifecycle: CrepeLifecycle = mountCrepeSerially({
      root: el,
      crepe,
      label: `wysiwyg:${path}`,
      onCreated: () => {
        if (stopped) return;
        const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
        onEditorAdapterChange({
          focus: () => view.focus(),
          insertTextAtPoint: (text, point) => {
            const position = view.posAtCoords({ left: point.x, top: point.y });
            if (!position) return false;
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.near(view.state.doc.resolve(position.pos)),
              ),
            );
            const inserted = view.pasteText(text);
            if (inserted) view.focus();
            return inserted;
          },
        });
        scrollMemory = attachScrollMemory({
          key: `wysiwyg:${path}`,
          scroller: el,
          focusRoot: el,
        });
        // Crepe plugins may normalize the initial document for a frame after
        // create() resolves. Keep those transactions inside hydration, then
        // establish one stable serialization baseline.
        let frames = 2;
        const settle = (): void => {
          if (stopped) return;
          if (frames > 0) {
            frames -= 1;
            hydrationFrame = requestAnimationFrame(settle);
            return;
          }
          hydrationFrame = null;
          editorStore.finishBodyHydration(path, generation, crepe.getMarkdown());
        };
        hydrationFrame = requestAnimationFrame(settle);
      },
    });

    return () => {
      stopped = true;
      onEditorAdapterChange(null);
      if (hydrationFrame !== null) cancelAnimationFrame(hydrationFrame);
      scrollMemory?.stop();
      detachCopyFeedback();
      lifecycle.stop();
    };
    // Remount only on a different doc, an explicit generation bump, or a
    // BlockEdit toggle (Crepe features are fixed at create time) — NOT on
    // every keystroke's body prop drift. The toggle lives in SettingsView,
    // which replaces the three-pane body, so the editor is never mounted
    // when the flag actually flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, generation, blockEdit, i18n.resolvedLanguage, onEditorAdapterChange]);

  return (
    <div
      ref={rootRef}
      data-body-align={bodyAlign}
      className="crepe-host h-full min-w-0 w-full overflow-y-auto"
    />
  );
}
