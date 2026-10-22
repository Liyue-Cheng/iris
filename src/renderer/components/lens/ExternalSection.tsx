import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FilePlus,
  FileWarning,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import type { ExternalPathEntry, WorkspaceExternalPaths } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { runUserAction } from '@renderer/lib/action-runtime';
import { writeClipboardText } from '@renderer/lib/clipboard';
import { editorStore } from '@renderer/stores/editor-store';
import { useLensPrefs } from '@renderer/stores/lens-prefs';
import { projectScopeState, sameProjectScope } from '@renderer/stores/project-scope-state';
import { resolveSystemFilePaths, setExternalPathDragData } from '@renderer/lib/doc-drag';
import {
  addExternalPath,
  externalIdentity,
  listExternalPaths,
  openExternalPath,
  pickExternalPath,
  removeExternalPath,
  revealExternalPath,
} from '@renderer/lib/external-actions';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';

export function ExternalSection({
  external,
}: {
  external: WorkspaceExternalPaths;
}): JSX.Element {
  const { t } = useTranslation();
  const { filter } = useLensPrefs();
  const [inventory, setInventory] = useState(external);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const adding = useRef(false);

  const clearDrag = (): void => {
    dragDepth.current = 0;
    setDragging(false);
  };

  useEffect(() => {
    window.addEventListener('drop', clearDrag);
    window.addEventListener('dragend', clearDrag);
    window.addEventListener('blur', clearDrag);
    return () => {
      window.removeEventListener('drop', clearDrag);
      window.removeEventListener('dragend', clearDrag);
      window.removeEventListener('blur', clearDrag);
    };
  }, []);

  useEffect(() => setInventory(external), [external]);
  const refresh = async (): Promise<void> => {
    setInventory(await listExternalPaths(external.workspacePath));
  };

  const add = async (kind: 'file' | 'directory'): Promise<void> => {
    const scope = projectScopeState.get();
    if (!scope || adding.current) return;
    adding.current = true;
    setBusy(true);
    try {
      await runUserAction(
        { title: t('external.addFailed'), dedupeKey: `external:add:${external.workspacePath}` },
        async () => {
          const target = await pickExternalPath(kind);
          if (!target || !sameProjectScope(scope, projectScopeState.get())) return;
          await addExternalPath(external.workspacePath, target);
          await refresh();
        },
      );
    } finally {
      adding.current = false;
      setBusy(false);
    }
  };

  const acceptsFiles = (event: DragEvent<HTMLDivElement>): boolean =>
    event.dataTransfer.types.includes('Files') || event.dataTransfer.files.length > 0;

  const dropFiles = async (files: File[]): Promise<void> => {
    const scope = projectScopeState.get();
    if (!scope || adding.current) return;
    adding.current = true;
    setBusy(true);
    setOpen(true);
    try {
      await runUserAction(
        { title: t('external.addFailed'), dedupeKey: `external:add:${external.workspacePath}` },
        async () => {
          const resolved = resolveSystemFilePaths(files, window.api.getPathForFile);
          const failures: string[] = [];
          if (resolved.length < files.length || files.length === 0) {
            failures.push(t('external.dropPathFailed'));
          }
          // Serialize writes to the same manifest and keep valid files in a mixed drop.
          for (const target of new Set(resolved)) {
            if (!sameProjectScope(scope, projectScopeState.get())) return;
            try {
              await addExternalPath(external.workspacePath, target);
            } catch (error) {
              failures.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (!sameProjectScope(scope, projectScopeState.get())) return;
          await refresh();
          if (failures.length > 0) throw new Error(failures.join('\n'));
        },
      );
    } finally {
      adding.current = false;
      setBusy(false);
    }
  };

  const visible = inventory.entries.filter((entry) => {
    if (!filter) return true;
    const query = filter.toLowerCase();
    return entry.name.toLowerCase().includes(query) || entry.storedPath.toLowerCase().includes(query);
  });

  return (
    <div
      role="region"
      aria-label="External"
      aria-busy={busy}
      className={cn(
        'group/section relative rounded-md transition-colors',
        dragging && 'bg-accent/50 ring-1 ring-inset ring-primary',
      )}
      onDragEnter={(event) => {
        if (!acceptsFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current += 1;
        if (!adding.current) setDragging(true);
      }}
      onDragOver={(event) => {
        if (!acceptsFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = adding.current ? 'none' : 'copy';
      }}
      onDragLeave={(event) => {
        event.stopPropagation();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        clearDrag();
        if (!acceptsFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        // Snapshot FileList before the browser clears the drag data store.
        void dropFiles(Array.from(event.dataTransfer.files)).catch(() => undefined);
      }}
    >
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          aria-label={open ? t('layout.collapse') : t('layout.expand')}
          onClick={() => setOpen((value) => !value)}
          className="shrink-0 px-1 py-0.5 text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <Link2 className="h-3.5 w-3.5" />
          External
          <span className="ml-1 font-normal text-muted-foreground/60">{visible.length}</span>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label={t('external.adding')} />}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={busy}
              aria-label={t('external.add')}
              className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void add('file').catch(() => undefined)}>
              <FilePlus /> {t('external.addFile')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void add('directory').catch(() => undefined)}>
              <FolderPlus /> {t('external.addFolder')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <div className="pb-1">
          {visible.map((entry) => (
            <ExternalRow
              key={`${entry.line}:${entry.storedPath}`}
              workspacePath={external.workspacePath}
              entry={entry}
              onChanged={refresh}
            />
          ))}
          {visible.length === 0 && (
            <div className="mx-1 mb-1 rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
              {t(inventory.entries.length === 0 ? 'external.dropHint' : 'common.empty')}
            </div>
          )}
        </div>
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-md border border-dashed border-primary bg-background/95 px-3 py-1 text-xs font-medium text-primary" role="status">
          <Link2 className="h-4 w-4 shrink-0" />
          <span>{t('external.dropRelease')}</span>
        </div>
      )}
    </div>
  );
}

function ExternalRow({
  workspacePath,
  entry,
  onChanged,
}: {
  workspacePath: string;
  entry: ExternalPathEntry;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation();
  const identity = externalIdentity(workspacePath, entry);
  const canUse = entry.exists && entry.absolutePath !== null;
  const open = (): void => {
    void editorStore.flushBeforeSwitch('before-external-action').then((ready) => {
      if (ready) void openExternalPath(identity).catch(() => undefined);
    });
  };
  const remove = async (): Promise<void> => {
    await runUserAction(
      { title: t('external.removeFailed'), dedupeKey: `external:remove:${workspacePath}:${entry.line}` },
      async () => {
        await removeExternalPath(identity);
        await onChanged();
      },
    );
  };
  const row = (
    <button
      type="button"
      aria-disabled={!canUse}
      draggable={canUse}
      onDragStart={(event) => {
        if (entry.absolutePath) setExternalPathDragData(event.dataTransfer, entry.absolutePath);
      }}
      onClick={() => { if (canUse) open(); }}
      aria-label={entry.absolutePath ?? entry.storedPath}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm leading-tight',
        canUse ? 'hover:bg-muted' : 'cursor-default text-muted-foreground/60',
      )}
    >
      <span className="flex w-3 shrink-0 items-center justify-center">
        {entry.error && <FileWarning className="h-3.5 w-3.5 text-[var(--rp-gold)]" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {!entry.error && entry.kind === 'directory' && (
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel className="max-w-64 truncate">{entry.storedPath}</ContextMenuLabel>
        <ContextMenuItem disabled={!canUse} onClick={open}>
          <ExternalLink /> {t('common.openDefault')}
        </ContextMenuItem>
        <ContextMenuItem disabled={!canUse} onClick={() => void revealExternalPath(identity).catch(() => undefined)}>
          <FolderOpen /> {t('common.reveal')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!entry.absolutePath} onClick={() => entry.absolutePath && void writeClipboardText(entry.absolutePath)}>
          <Copy /> {t('external.copyAbsolutePath')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void writeClipboardText(entry.storedPath)}>
          <Copy /> {t('external.copyStoredPath')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive focus:text-destructive" onClick={() => void remove().catch(() => undefined)}>
          <Trash2 /> {t('external.remove')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
