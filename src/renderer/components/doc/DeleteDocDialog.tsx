/**
 * Delete-file dialog (round-3 I 条). Deletion is irreversible, so it always
 * confirms — and when terminals are anchored on the doc it offers the two
 * agreed branches: close those sessions, or re-anchor them to the project
 * root (Marina's anchoring model — the path edits the doc, the PTY lives on).
 *
 * Note the constitution's "issues are not deleted, flip status" rule binds
 * the AGENT's write-back behavior; this is the human's UI gesture.
 */
import { useState, useSyncExternalStore } from 'react';
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
  const { sessions } = useSessions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!t) return null;

  const anchored = sessions.filter((s) => s.docPath === t.docPath);

  const close = (): void => {
    target = null;
    setBusy(false);
    setError(null);
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
            删除 {t.docName}
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          将从磁盘删除 <code className="rounded bg-muted px-1 text-xs">{t.docPath}</code>
          ，此操作不可逆。
        </p>

        {anchored.length > 0 && (
          <p className="text-sm">
            该文档还挂着{' '}
            <span className="font-semibold">{anchored.length}</span> 个终端会话（
            {anchored.map((s) => s.displayName).join('、')}
            ）——选择如何处理它们：
          </p>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* Buttons stack vertically full-width: the branch labels are long and
            a horizontal footer overflowed the dialog (round-3 验收反馈). */}
        {anchored.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Button
              variant="destructive"
              className="w-full"
              disabled={busy}
              onClick={() => void run('close-sessions')}
            >
              关闭这些终端并删除
            </Button>
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy}
              title="会话保留，锚点改为项目根"
              onClick={() => void run('reanchor-root')}
            >
              重新锚定到项目根并删除
            </Button>
            <Button variant="ghost" className="w-full" onClick={close} disabled={busy}>
              取消
            </Button>
          </div>
        ) : (
          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>
              取消
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void run('close-sessions')}>
              删除
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
