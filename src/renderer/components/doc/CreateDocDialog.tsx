/**
 * "New doc" dialog. Opened from a type section's + button in the lens tree.
 * The verb is the doc.create instruction (date-prefixed names in issue/ and
 * report/, collision-safe in main); the new doc is selected on success and
 * the tree lights up via the watcher loop.
 */
import { useState, useSyncExternalStore } from 'react';
import type { DocType } from '@shared/types';
import { pipeline } from '@renderer/cpu';
import { projectStore } from '@renderer/stores/project-store';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';

interface CreateTarget {
  workspacePath: string;
  type: DocType;
}

let target: CreateTarget | null = null;
const subs = new Set<() => void>();

export function openCreateDialog(t: CreateTarget): void {
  target = t;
  subs.forEach((cb) => cb());
}

function useTarget(): CreateTarget | null {
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

export function CreateDocDialog(): JSX.Element | null {
  const t = useTarget();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!t) return null;

  const close = (): void => {
    target = null;
    setTitle('');
    setError(null);
    setBusy(false);
    subs.forEach((cb) => cb());
  };

  const create = async (): Promise<void> => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await pipeline.dispatch('doc.create', {
        workspacePath: t.workspacePath,
        type: t.type,
        title: title.trim(),
      })) as { path: string };
      close();
      // Switch to the new doc AND drop the cursor into its (empty) body, so
      // creating a doc is immediately writable without a second manual click.
      void projectStore.selectDoc(result.path, { focusEditor: true });
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            新建 {t.type} 文档
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {t.workspacePath}/{t.type}/
            </span>
          </DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button onClick={() => void create()} disabled={!title.trim() || busy}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
