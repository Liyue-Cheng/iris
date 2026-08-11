/**
 * Single-doc view (M2): typed header + WYSIWYG body (Crepe) with the
 * CodeMirror source-mode escape hatch. Replaces M1's read-only DocPreview.
 *
 * Save surfaces: Ctrl+S, window blur, doc switch (project-store flushes),
 * and immediate persist on header field edits.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, TriangleAlert } from 'lucide-react';
import { CHANNELS, type WindowEditAction } from '@shared/protocol';
import { useEditorSession, editorStore } from '@renderer/stores/editor-store';
import { projectStore, useProject } from '@renderer/stores/project-store';
import { useSettings } from '@renderer/stores/settings-store';
import { Button } from '@renderer/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  runAfterContextMenuClose,
} from '@renderer/components/ui/context-menu';
import {
  governEditorPathDrop,
  isEditorPathDrag,
  type EditorAdapter,
} from '@renderer/lib/doc-drag';
import { TypedHeader } from './TypedHeader';
import { CrepeEditor } from './CrepeEditor';
import { SourceEditor } from './SourceEditor';

export function DocView(): JSX.Element {
  const { t } = useTranslation();
  const session = useEditorSession();
  const { view, docLoading, docError } = useProject();
  const selectedPath =
    view.kind === 'doc'
      ? view.path
      : view.kind === 'collection' && view.type === 'issue'
        ? view.selectedPath
        : null;
  const isIssueDetail = view.kind === 'collection' && view.type === 'issue';
  const conflictPolicy = useSettings()?.behavior.editorConflictPolicy ?? 'ask';
  const editorAdapterRef = useRef<EditorAdapter | null>(null);
  const [dropError, setDropError] = useState<{ kind: 'path' | 'insert' } | null>(null);

  const handleEditorAdapterChange = useCallback((adapter: EditorAdapter | null): void => {
    editorAdapterRef.current = adapter;
  }, []);

  const handleEditAction = useCallback((action: WindowEditAction): void => {
    const adapter = editorAdapterRef.current;
    if (!adapter) return;
    runAfterContextMenuClose(
      () => adapter.focus(),
      () => {
        void window.api.invoke(CHANNELS.WINDOW_EDIT_ACTION, { action });
      },
    );
  }, []);

  const handlePathDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    if (!isEditorPathDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handlePathDrop = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    const result = governEditorPathDrop(
      event,
      window.api.getPathForFile,
      editorAdapterRef.current,
    );
    if (result === 'ignored' || result === 'inserted') {
      if (result === 'inserted') setDropError(null);
      return;
    }
    if (result === 'path-unavailable') {
      setDropError({ kind: 'path' });
      return;
    }
    setDropError({ kind: 'insert' });
  }, []);

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

  useEffect(() => {
    if (!dropError) return;
    const timer = window.setTimeout(() => setDropError(null), 4000);
    return () => window.clearTimeout(timer);
  }, [dropError]);

  useEffect(() => {
    setDropError(null);
  }, [session?.path, session?.mode]);

  if (!selectedPath) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('editor.selectDocument')}
      </div>
    );
  }

  if (docError) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-destructive">
        {t('editor.readFailed', { error: docError })}
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
    <div
      className="doc-view flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-pane-layout={isIssueDetail ? 'fluid' : 'reading'}
    >
      <TypedHeader
        session={session}
        fluid={isIssueDetail}
        {...(isIssueDetail
          ? { onOpenInDefaultView: () => void projectStore.openIssueInDefaultView() }
          : {})}
      />
      {session.conflict && conflictPolicy === 'ask' && (
        <div className="flex shrink-0 items-center gap-2 border-y border-[var(--rp-gold)]/35 bg-[var(--rp-gold)]/10 px-4 py-2 text-xs">
          <TriangleAlert className="size-4 shrink-0 text-[var(--rp-gold)]" />
          <span className="min-w-0 flex-1">
            {t('editor.diskChanged')}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0"
            onClick={() => editorStore.reloadConflict()}
          >
            {t('editor.reloadExternal')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 shrink-0"
            disabled={session.saving}
            onClick={() => void editorStore.overwriteConflict()}
          >
            {t('editor.keepLocal')}
          </Button>
        </div>
      )}
      {dropError && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-y border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
        >
          <TriangleAlert className="size-4 shrink-0" />
          <span>
            {dropError.kind === 'path'
              ? t('editor.fileDropPathFailed')
              : t('editor.fileDropInsertFailed')}
          </span>
        </div>
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
            onDragEnterCapture={handlePathDragOver}
            onDragOverCapture={handlePathDragOver}
            onDropCapture={handlePathDrop}
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
                onEditorAdapterChange={handleEditorAdapterChange}
              />
            ) : (
              <SourceEditor
                path={session.path}
                generation={session.generation}
                text={session.sourceText}
                onEditorAdapterChange={handleEditorAdapterChange}
              />
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => handleEditAction('cut')}>
            {t('common.cut')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleEditAction('copy')}>
            {t('common.copy')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleEditAction('paste')}>
            {t('common.paste')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => handleEditAction('selectAll')}>
            {t('common.selectAll')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
