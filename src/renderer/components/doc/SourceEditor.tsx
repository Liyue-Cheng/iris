/**
 * CodeMirror 6 source mode — the precise-editing escape hatch. Shows the
 * FULL file (frontmatter included) verbatim; saving from this mode writes
 * the buffer bytes unmodified.
 */
import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Transaction } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { rosePineCodeMirror } from '@renderer/styles/codemirror-theme';
import { editorStore } from '@renderer/stores/editor-store';
import { attachScrollMemory } from '@renderer/lib/scroll-memory';
import type { EditorDropAdapter } from '@renderer/lib/doc-drag';

export function SourceEditor({
  path,
  generation,
  text,
  onDropAdapterChange,
}: {
  path: string;
  generation: number;
  text: string;
  onDropAdapterChange: (adapter: EditorDropAdapter | null) => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          markdown(),
          // After basicSetup → overrides the light defaultHighlightStyle with
          // Rose Pine (shared with the WYSIWYG code blocks). Also sets the mono
          // font, so only height/fontSize remain editor-specific below.
          rosePineCodeMirror,
          EditorView.lineWrapping,
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              editorStore.setSourceText(path, generation, update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    const scrollMemory = attachScrollMemory({
      key: `source:${path}`,
      scroller: view.scrollDOM,
      focusRoot: host,
    });
    onDropAdapterChange({
      insertTextAtPoint: (insertedText, point) => {
        const position = view.posAtCoords(point, false);
        if (position === null) return false;
        view.dispatch({
          changes: { from: position, insert: insertedText },
          selection: { anchor: position + insertedText.length },
          annotations: Transaction.userEvent.of('input.drop'),
          scrollIntoView: true,
        });
        view.focus();
        return true;
      },
    });

    return () => {
      onDropAdapterChange(null);
      scrollMemory.stop();
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, generation, onDropAdapterChange]);

  return <div ref={hostRef} className="cm-host h-full overflow-hidden" />;
}
