/**
 * Single-doc view (M2): typed header + WYSIWYG body (Crepe) with the
 * CodeMirror source-mode escape hatch. Replaces M1's read-only DocPreview.
 *
 * Save surfaces: Ctrl+S, window blur, doc switch (project-store flushes),
 * and immediate persist on header field edits.
 */
import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useEditorSession, editorStore } from '@renderer/stores/editor-store';
import { useProject } from '@renderer/stores/project-store';
import { TypedHeader } from './TypedHeader';
import { CrepeEditor } from './CrepeEditor';
import { SourceEditor } from './SourceEditor';

export function DocView(): JSX.Element {
  const session = useEditorSession();
  const { selectedPath, docLoading, docError } = useProject();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void editorStore.save();
      }
    };
    const onBlur = (): void => {
      void editorStore.save();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  if (!selectedPath) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        从左栏选择一篇文档
      </div>
    );
  }

  if (docError) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-destructive">
        读取失败：{docError}
      </div>
    );
  }

  if (!session || docLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TypedHeader session={session} />
      <div className="min-h-0 flex-1">
        {session.mode === 'wysiwyg' ? (
          <CrepeEditor
            path={session.path}
            generation={session.generation}
            body={session.originalBody}
          />
        ) : (
          <SourceEditor
            path={session.path}
            generation={session.generation}
            text={session.sourceText}
          />
        )}
      </div>
    </div>
  );
}
