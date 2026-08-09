/**
 * Sub-workspace wizard (创建是人的手势 — agents never create workspaces).
 * Parent selector + name + template choice (standard four folders / empty
 * custom shaped later).
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
          <DialogTitle>{t('project.newWorkspace')}</DialogTitle>
          <DialogDescription>
            {t('project.workspaceDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('project.parentWorkspace')}</label>
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
            <label className="text-xs text-muted-foreground">{t('project.workspaceName')}</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
              placeholder={t('project.reservedNames')}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { id: 'standard', title: t('project.standard'), desc: t('project.standardDescription') },
                { id: 'empty', title: t('project.emptyCustom'), desc: t('project.emptyCustomDescription') },
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
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void create()} disabled={!name.trim() || busy}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
