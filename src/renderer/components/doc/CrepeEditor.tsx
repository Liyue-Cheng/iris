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
 * Context menu (round-3 J 条): the standard edit quartet via the shared
 * menu. Actions go through webContents (window:edit-action) — the only
 * paste path with full clipboard fidelity (execCommand('paste') is
 * privileged); focus returns to ProseMirror first so the action lands on
 * the editor's preserved selection.
 */
import { useEffect, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import { languages } from '@codemirror/language-data';
import { rosePineCodeMirror } from '@renderer/styles/codemirror-theme';
import { CHANNELS } from '@shared/protocol';
import { editorStore } from '@renderer/stores/editor-store';
import { mountCrepeSerially, type CrepeLifecycle } from '@renderer/lib/crepe-lifecycle';
import { useSettings } from '@renderer/stores/settings-store';
import { markImageLoadFailure, resolveMarkdownImage } from '@renderer/lib/markdown-media';
import { renderMermaidPreview } from '@renderer/lib/mermaid-preview';
import { importAsset } from '@renderer/lib/asset-actions';
import { attachScrollMemory, type ScrollMemoryHandle } from '@renderer/lib/scroll-memory';
import { stableCodeBlockView } from '@renderer/lib/stable-code-block';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';

import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

type EditAction = 'cut' | 'copy' | 'paste' | 'selectAll';

export function CrepeEditor({
  path,
  generation,
  body,
}: {
  path: string;
  generation: number;
  body: string;
}): JSX.Element {
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
          copyText: '复制',
          renderPreview: renderMermaidPreview,
          previewOnlyByDefault: true,
          previewLabel: '预览',
          previewLoading: '渲染中…',
        },
        [Crepe.Feature.ImageBlock]: {
          onUpload: async (file) => (await importAsset(path, file)).markdownUrl,
          proxyDomURL: (source) => resolveMarkdownImage(path, source),
          onImageLoadError: markImageLoadFailure,
          inlineUploadButton: '上传',
          blockUploadButton: '上传图片',
          inlineUploadPlaceholderText: '或粘贴链接',
          blockUploadPlaceholderText: '或粘贴链接',
        },
      },
    });
    crepe.editor.use(stableCodeBlockView);

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
      if (hydrationFrame !== null) cancelAnimationFrame(hydrationFrame);
      scrollMemory?.stop();
      lifecycle.stop();
    };
    // Remount only on a different doc, an explicit generation bump, or a
    // BlockEdit toggle (Crepe features are fixed at create time) — NOT on
    // every keystroke's body prop drift. The toggle lives in SettingsView,
    // which replaces the three-pane body, so the editor is never mounted
    // when the flag actually flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, generation, blockEdit]);

  const editAction = (action: EditAction): void => {
    // Radix closes the menu and juggles focus on select; wait a beat, put
    // focus back into ProseMirror (its selection survives the round trip),
    // then fire the webContents action on the now-focused editable.
    window.setTimeout(() => {
      rootRef.current?.querySelector<HTMLElement>('.ProseMirror')?.focus();
      window.setTimeout(() => {
        void window.api.invoke(CHANNELS.WINDOW_EDIT_ACTION, { action });
      }, 0);
    }, 50);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rootRef}
          data-body-align={bodyAlign}
          className="crepe-host h-full overflow-y-auto"
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => editAction('cut')}>剪切</ContextMenuItem>
        <ContextMenuItem onClick={() => editAction('copy')}>复制</ContextMenuItem>
        <ContextMenuItem onClick={() => editAction('paste')}>粘贴</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => editAction('selectAll')}>全选</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
