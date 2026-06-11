/**
 * CodeMirror 6 source mode — the precise-editing escape hatch. Shows the
 * FULL file (frontmatter included) verbatim; saving from this mode writes
 * the buffer bytes unmodified.
 */
import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { editorStore } from '@renderer/stores/editor-store';

export function SourceEditor({
  path,
  generation,
  text,
}: {
  path: string;
  generation: number;
  text: string;
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
          EditorView.lineWrapping,
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-content': {
              fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              editorStore.setSourceText(update.state.doc.toString());
            }
          }),
        ],
      }),
    });

    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, generation]);

  return <div ref={hostRef} className="cm-host h-full overflow-hidden" />;
}
