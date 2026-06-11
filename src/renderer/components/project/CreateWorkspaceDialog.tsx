/**
 * Sub-workspace wizard (创建是人的手势 — agents never create workspaces).
 * Parent selector + name + template choice (standard four folders / empty
 * custom shaped later).
 */
import { useMemo, useState } from 'react';
import type { IrisWorkspace } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { pipeline } from '@renderer/cpu';
import { useProject } from '@renderer/stores/project-store';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';

function flattenWorkspaces(root: IrisWorkspace): { path: string; label: string }[] {
  const out: { path: string; label: string }[] = [];
  const walk = (ws: IrisWorkspace, depth: number, archived: boolean): void => {
    const isArchived = archived || ws.archived;
    if (!isArchived) {
      out.push({ path: ws.path, label: `${'　'.repeat(depth)}${depth === 0 ? ws.name : ws.path.split('/').pop()}` });
    }
    ws.children.forEach((c) => walk(c, depth + 1, isArchived));
  };
  walk(root, 0, false);
  return out;
}

export function CreateWorkspaceDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const { scan } = useProject();
  const [name, setName] = useState('');
  const [parent, setParent] = useState('.iris');
  const [template, setTemplate] = useState<'standard' | 'empty'>('standard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parents = useMemo(
    () => (scan?.root ? flattenWorkspaces(scan.root) : [{ path: '.iris', label: '.iris' }]),
    [scan],
  );

  if (!scan?.root) return null;

  const close = (): void => {
    setName('');
    setError(null);
    setBusy(false);
    onClose();
  };

  const create = async (): Promise<void> => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await pipeline.dispatch('workspace.create', {
        parentPath: parent,
        name: name.trim(),
        template,
      });
      close();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>新建工作区</DialogTitle>
          <DialogDescription>
            子工作区用于独立探索、临时攻坚。生死同域：失败删整个文件夹，成功把有价值的文档晋升到父级。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">父工作区</label>
            <select
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {parents.map((p) => (
                <option key={p.path} value={p.path} className="bg-popover">
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">名字（如 spike-auth）</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
              placeholder="不能叫 status / issue / report / misc"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { id: 'standard', title: '标准', desc: '四个类型文件夹齐备' },
                { id: 'empty', title: '空自定义', desc: '空文件夹，之后自己加类型文件夹' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplate(t.id)}
                className={cn(
                  'rounded-md border p-2 text-left',
                  template === t.id ? 'border-ring bg-accent' : 'border-input hover:bg-muted/60',
                )}
              >
                <div className="text-sm font-medium">{t.title}</div>
                <div className="text-[11px] text-muted-foreground">{t.desc}</div>
              </button>
            ))}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button onClick={() => void create()} disabled={!name.trim() || busy}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
