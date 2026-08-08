/**
 * Single-doc view (M2): typed header + WYSIWYG body (Crepe) with the
 * CodeMirror source-mode escape hatch. Replaces M1's read-only DocPreview.
 *
 * Save surfaces: Ctrl+S, window blur, doc switch (project-store flushes),
 * and immediate persist on header field edits.
 */
import { useEffect } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { useEditorSession, editorStore } from '@renderer/stores/editor-store';
import { useProject } from '@renderer/stores/project-store';
import { useSettings } from '@renderer/stores/settings-store';
import { Button } from '@renderer/components/ui/button';
import { TypedHeader } from './TypedHeader';
import { CrepeEditor } from './CrepeEditor';
import { SourceEditor } from './SourceEditor';

export function DocView(): JSX.Element {
  const session = useEditorSession();
  const { selectedPath, docLoading, docError } = useProject();
  const conflictPolicy = useSettings()?.behavior.editorConflictPolicy ?? 'ask';

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void editorStore.save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
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
      {session.conflict && conflictPolicy === 'ask' && (
        <div className="flex shrink-0 items-center gap-2 border-y border-[var(--rp-gold)]/35 bg-[var(--rp-gold)]/10 px-4 py-2 text-xs">
          <TriangleAlert className="size-4 shrink-0 text-[var(--rp-gold)]" />
          <span className="min-w-0 flex-1">
            磁盘版本已变化，自动保存已暂停。选择保留本地草稿或重新载入外部版本。
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0"
            onClick={() => editorStore.reloadConflict()}
          >
            载入外部版本
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 shrink-0"
            disabled={session.saving}
            onClick={() => void editorStore.overwriteConflict()}
          >
            保留本地并覆盖
          </Button>
        </div>
      )}
      <div
        className="min-h-0 flex-1"
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
            editorStore.handleEditorBlur();
          }
        }}
      >
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
