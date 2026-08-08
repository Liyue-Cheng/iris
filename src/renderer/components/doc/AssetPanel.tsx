import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  File,
  FolderOpen,
  Image,
  Loader2,
  PackagePlus,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import type { AssetEntry, AssetHealth, AssetInventory } from '@shared/types';
import { EVENTS } from '@shared/protocol';
import { cn } from '@renderer/lib/utils';
import { pipeline } from '@renderer/cpu';
import { confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { Button } from '@renderer/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { writeClipboardText } from '@renderer/lib/clipboard';
import {
  adoptAsset,
  importAsset,
  listAssets,
  markdownForAsset,
  trashAsset,
} from '@renderer/lib/asset-actions';

const HEALTH_LABEL: Record<AssetHealth, string> = {
  referenced: '已引用',
  orphan: '孤儿',
  missing: '缺失',
  unmanaged: '非受管',
};

export function AssetPanel({
  docPath,
  open,
  onOpenChange,
}: {
  docPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [inventory, setInventory] = useState<AssetInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setInventory(await listAssets(docPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [docPath]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    return window.api.on<{ changes: Array<{ path: string }> }>(EVENTS.FS_IRIS_CHANGED, (event) => {
      const directory = inventory?.directoryPath;
      if (
        event.changes.some(
          (change) =>
            change.path === docPath ||
            (directory !== undefined && change.path.startsWith(`${directory}/`)),
        )
      ) {
        void refresh();
      }
    });
  }, [docPath, inventory?.directoryPath, open, refresh]);

  const importFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      let lastMarkdown = '';
      for (const file of Array.from(files)) {
        const result = await importAsset(docPath, file);
        lastMarkdown = markdownForAsset(result);
      }
      if (files.length === 1 && lastMarkdown) await writeClipboardText(lastMarkdown);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const removeOrphan = async (asset: AssetEntry): Promise<void> => {
    const confirmed = await confirmDialog({
      title: '删除孤儿资产',
      message: `${asset.name} 当前没有 Markdown 引用，将移入系统回收站。`,
      confirmText: '移入回收站',
      tone: 'destructive',
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await trashAsset(docPath, asset.path);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const adoptLegacy = async (asset: AssetEntry): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await adoptAsset(docPath, asset.markdownUrl);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const assets = inventory?.assets ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-3 p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="text-base">文档资产</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 px-5">
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => void importFiles(event.target.files)}
          />
          <Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
            {busy ? <Loader2 className="animate-spin" /> : <Upload />}
            添加
          </Button>
          <IconAction label="刷新" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </IconAction>
          <span className="ml-auto text-xs text-muted-foreground">
            {inventory ? `${assets.length} 项` : ''}
          </span>
        </div>

        {error && (
          <p className="mx-5 flex items-start gap-2 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {error}
          </p>
        )}

        <div className="max-h-[55vh] min-h-40 overflow-y-auto border-t">
          {loading && !inventory ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : assets.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              暂无资产
            </div>
          ) : (
            assets.map((asset) => (
              <AssetRow
                key={`${asset.health}:${asset.path}:${asset.markdownUrl}`}
                asset={asset}
                disabled={busy}
                onAdopt={() => void adoptLegacy(asset)}
                onRemove={() => void removeOrphan(asset)}
              />
            ))
          )}
        </div>

        <div className="truncate border-t px-5 py-3 font-mono text-[11px] text-muted-foreground">
          {inventory?.directoryPath ?? docPath}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AssetRow({
  asset,
  disabled,
  onAdopt,
  onRemove,
}: {
  asset: AssetEntry;
  disabled: boolean;
  onAdopt: () => void;
  onRemove: () => void;
}): JSX.Element {
  const canOpen = asset.health !== 'missing' && asset.path !== '';
  const canTrash = asset.health === 'orphan';
  const canAdopt = asset.health === 'unmanaged';
  return (
    <div className="flex min-h-12 items-center gap-3 border-b px-5 py-2 last:border-b-0">
      {asset.kind === 'image' ? (
        <Image className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <File className="size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm" title={asset.name}>{asset.name}</div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span
            className={cn(
              asset.health === 'missing' && 'text-destructive',
              asset.health === 'orphan' && 'text-[var(--rp-gold)]',
            )}
          >
            {HEALTH_LABEL[asset.health]}
          </span>
          {asset.size !== null && <span>{formatBytes(asset.size)}</span>}
          {asset.referenceCount > 0 && <span>{asset.referenceCount} 处引用</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {canAdopt && (
          <IconAction label="收编为受管资产" disabled={disabled} onClick={onAdopt}>
            <PackagePlus />
          </IconAction>
        )}
        <IconAction
          label="复制 Markdown 链接"
          disabled={asset.health === 'missing'}
          onClick={() => void writeClipboardText(markdownForAsset(asset))}
        >
          <Copy />
        </IconAction>
        <IconAction
          label="在资源管理器中显示"
          disabled={!canOpen}
          onClick={() => void pipeline.dispatch('shell.reveal-project-item', { path: asset.path })}
        >
          <FolderOpen />
        </IconAction>
        <IconAction
          label="用默认程序打开"
          disabled={!canOpen}
          onClick={() => void pipeline.dispatch('shell.open-project-item', { path: asset.path })}
        >
          <ExternalLink />
        </IconAction>
        {canTrash && (
          <IconAction label="移入回收站" disabled={disabled} destructive onClick={onRemove}>
            <Trash2 />
          </IconAction>
        )}
      </div>
    </div>
  );
}

function IconAction({
  label,
  children,
  disabled = false,
  destructive = false,
  onClick,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('size-7', destructive && 'text-destructive hover:text-destructive')}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
