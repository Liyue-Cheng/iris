/**
 * Delete-file dialog (round-3 I 条). The document and its companion assets
 * move to the system trash together; when terminals are anchored it offers
 * agreed branches: close those sessions, or re-anchor them to the project
 * root (Marina's anchoring model — the path edits the doc, the PTY lives on).
 *
 * The software protocol's "issues are not deleted, flip status" rule binds
 * the agent's write-back behavior; this is the human's UI gesture.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { pipeline } from '@renderer/cpu';
import { useSessions } from '@renderer/stores/session-store';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { listAssets } from '@renderer/lib/asset-actions';

interface DeleteTarget {
  docPath: string;
  docName: string;
}

let target: DeleteTarget | null = null;
const subs = new Set<() => void>();

export function openDeleteDialog(t: DeleteTarget): void {
  target = t;
  subs.forEach((cb) => cb());
}

function useTarget(): DeleteTarget | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => target,
  );
}

export function DeleteDocDialog(): JSX.Element | null {
  const t = useTarget();
  const { t: tr } = useTranslation();
  const { sessions } = useSessions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetCount, setAssetCount] = useState<number | null>(null);

  useEffect(() => {
    if (!t) return;
    let current = true;
    setAssetCount(null);
    void listAssets(t.docPath)
      .then((inventory) => {
        if (current) setAssetCount(inventory.counts.referenced + inventory.counts.orphan);
      })
      .catch((err) => {
        if (current) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      current = false;
    };
  }, [t]);

  if (!t) return null;

  const anchored = sessions.filter((s) => s.docPath === t.docPath);

  const close = (): void => {
    target = null;
    setBusy(false);
    setError(null);
    setAssetCount(null);
    subs.forEach((cb) => cb());
  };

  /** Settle the anchored sessions per branch, then delete the file. */
  const run = async (mode: 'close-sessions' | 'reanchor-root'): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      for (const s of anchored) {
        if (mode === 'close-sessions') {
          await pipeline.dispatch('session.close', { sessionId: s.id });
        } else {
          await pipeline.dispatch('session.reanchor', { sessionId: s.id, docPath: null });
        }
      }
      await pipeline.dispatch('doc.delete', { path: t.docPath });
      close();
      // Tree/editor/selection cleanup rides the watcher's unlink event —
      // the same path external deletions already take.
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-destructive" />
            {tr('project.deleteDocument', { name: t.docName })}
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          {tr('project.trashPrefix')}<code className="rounded bg-muted px-1 text-xs">{t.docPath}</code>
          {assetCount === null
            ? tr('project.trashManagedAssets')
            : assetCount > 0
              ? tr('project.trashAssetCount', { count: assetCount })
              : ''}
          {tr('project.trashDestination')}
        </p>

        {anchored.length > 0 && (
          <p className="text-sm">{tr('project.anchoredSessions', {
            count: anchored.length,
            sessions: anchored.map((s) => s.displayName).join(', '),
          })}</p>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* Buttons stack vertically full-width: the branch labels are long and
            a horizontal footer overflowed the dialog (round-3 验收反馈). */}
        {anchored.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Button
              variant="destructive"
              className="w-full"
              disabled={busy || assetCount === null}
              onClick={() => void run('close-sessions')}
            >
              {tr('project.closeAndDelete')}
            </Button>
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy || assetCount === null}
              title={tr('project.reanchorHint')}
              onClick={() => void run('reanchor-root')}
            >
              {tr('project.reanchorAndDelete')}
            </Button>
            <Button variant="ghost" className="w-full" onClick={close} disabled={busy}>
              {tr('common.cancel')}
            </Button>
          </div>
        ) : (
          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>
              {tr('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy || assetCount === null}
              onClick={() => void run('close-sessions')}
            >
              {tr('common.delete')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
