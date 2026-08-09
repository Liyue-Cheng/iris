/**
 * Protocol-init confirmation. Touching the project root (AGENTS.md) is the
 * one sanctioned exception to 尊重边界 — hence an explicit dialog spelling
 * out every action before the verb fires. The scaffold itself is idempotent
 * (missing pieces only), so this same dialog also serves as "repair".
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectInitResult } from '@shared/types';
import { pipeline } from '@renderer/cpu';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

export function InitDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ProjectInitResult | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = (await pipeline.dispatch('project.init', {})) as ProjectInitResult;
      setDone(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const close = (): void => {
    setDone(null);
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('project.initializeTitle')}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-left">
              <p>{t('project.initializeIntro')}</p>
              <ul className="list-disc space-y-1 pl-5 text-xs">
                <li>
                  {t('project.initializeFolders')}
                </li>
                <li>
                  {t('project.initializeAgents')}
                </li>
              </ul>
              <p className="text-xs text-muted-foreground">
                {t('project.initializeUninstall')}
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        {done && (
          <div className="rounded-md bg-muted/60 p-3 text-xs">
            <p className="font-medium text-[var(--rp-pine)]">{t('project.complete')}</p>
            <p>
              {t('project.createdFolders', { folders: done.createdFolders.length > 0 ? done.createdFolders.join(', ') : t('project.foldersReady') })}
            </p>
            <p>
              AGENTS.md：
              {done.agentsMd === 'created'
                ? t('project.agentsCreated')
                : done.agentsMd === 'appended'
                  ? t('project.agentsAppended')
                  : done.agentsMd === 'updated'
                    ? t('project.agentsUpdated')
                    : t('project.agentsUnchanged')}
            </p>
            {done.foreignEntries.length > 0 && (
              <p className="mt-1 text-[var(--rp-gold)]">
                {t('project.foreignEntries', { entries: done.foreignEntries.join(', ') })}
              </p>
            )}
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          {done ? (
            <Button onClick={close}>{t('project.ok')}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void run()} disabled={busy}>
                {busy ? t('project.running') : t('project.run')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
