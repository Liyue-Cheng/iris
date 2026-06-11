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
 */
import { useEffect, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import { editorStore } from '@renderer/stores/editor-store';

import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

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

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    let destroyed = false;
    const crepe = new Crepe({
      root: el,
      defaultValue: body,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.Latex]: false,
      },
    });

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, md) => {
        if (!destroyed) editorStore.setBody(md);
      });
    });

    void crepe.create().then(() => {
      if (destroyed) return;
      editorStore.setBodyBaseline(crepe.getMarkdown());
    });

    return () => {
      destroyed = true;
      void crepe.destroy();
    };
    // Remount only on a different doc or an explicit generation bump —
    // NOT on every keystroke's body prop drift.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, generation]);

  return <div ref={rootRef} className="crepe-host h-full overflow-y-auto" />;
}
