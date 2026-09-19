import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FilePlus,
  FileWarning,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { ExternalPathEntry, WorkspaceExternalPaths } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { runUserAction } from '@renderer/lib/action-runtime';
import { writeClipboardText } from '@renderer/lib/clipboard';
import { editorStore } from '@renderer/stores/editor-store';
import { lensPrefs, useLensPrefs } from '@renderer/stores/lens-prefs';
import { projectScopeState, sameProjectScope } from '@renderer/stores/project-scope-state';
import { setExternalPathDragData } from '@renderer/lib/doc-drag';
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
  archived,
}: {
  external: WorkspaceExternalPaths;
  archived: boolean;
}): JSX.Element | null {
  const { t } = useTranslation();
  const { filter, revealIntent } = useLensPrefs();
  const [inventory, setInventory] = useState(external);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setInventory(external), [external]);
  useEffect(() => {
    if (revealIntent?.workspacePath !== external.workspacePath) return;
    setOpen(true);
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'nearest' }));
    lensPrefs.clearReveal(revealIntent.nonce);
  }, [external.workspacePath, revealIntent]);

  const refresh = async (): Promise<void> => {
    setBusy(true);
    try {
      setInventory(await listExternalPaths(external.workspacePath));
    } finally {
      setBusy(false);
    }
  };

  const add = async (kind: 'file' | 'directory'): Promise<void> => {
    const scope = projectScopeState.get();
    if (!scope) return;
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
      setBusy(false);
    }
  };

  const visible = inventory.entries.filter((entry) => {
    if (!filter) return true;
    const query = filter.toLowerCase();
    return entry.name.toLowerCase().includes(query) || entry.storedPath.toLowerCase().includes(query);
  });
  if (!inventory.exists && inventory.entries.length === 0) return null;

  return (
    <div ref={rootRef} className="group/section">
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
          {t('external.title')}
          <span className="ml-1 font-normal text-muted-foreground/60">{visible.length}</span>
        </button>
        {!archived && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={busy}
                aria-label={t('external.add')}
                className="rounded-sm p-0.5 text-muted-foreground/0 hover:bg-muted hover:!text-foreground group-hover/section:text-muted-foreground"
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
        )}
        <button
          type="button"
          disabled={busy}
          aria-label={t('common.refresh')}
          onClick={() => void runUserAction(
            { title: t('common.refresh'), dedupeKey: `external:refresh:${external.workspacePath}` },
            refresh,
          )}
          className="rounded-sm p-0.5 text-muted-foreground/0 hover:bg-muted hover:!text-foreground group-hover/section:text-muted-foreground"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
        </button>
      </div>
      {open && (
        <div className="pb-1">
          {visible.map((entry) => (
            <ExternalRow
              key={`${entry.line}:${entry.storedPath}`}
              workspacePath={external.workspacePath}
              entry={entry}
              archived={archived}
              onChanged={refresh}
            />
          ))}
          {visible.length === 0 && (
            <div className="px-7 py-0.5 text-xs text-muted-foreground/50">{t('common.empty')}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ExternalRow({
  workspacePath,
  entry,
  archived,
  onChanged,
}: {
  workspacePath: string;
  entry: ExternalPathEntry;
  archived: boolean;
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
  const Icon = entry.error ? FileWarning : entry.kind === 'directory' ? Folder : File;
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
      <Icon className={cn('h-3.5 w-3.5 shrink-0', entry.error && 'text-[var(--rp-gold)]')} />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
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
        {!archived && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem className="text-destructive focus:text-destructive" onClick={() => void remove().catch(() => undefined)}>
              <Trash2 /> {t('external.remove')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
