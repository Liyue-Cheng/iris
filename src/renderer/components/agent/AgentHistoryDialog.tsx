/**
 * One anchor's Iris Agent history.
 *
 * Every Session ever opened against this document (or workspace hub) appears
 * here — live and closed alike. Closing an instance no longer deletes it, so
 * this list is where a finished conversation is found again. Each row offers
 * exactly two actions, per the issue: switch back into that Session, or open a
 * new instance that inherits its Trace.
 */
import { useEffect, useState } from 'react';
import { Bot, History, Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { IrisAgentAnchor, IrisAgentHistoryEntry, IrisAgentSessionInfo } from '@shared/types';
import { listIrisAgentHistory, reopenIrisAgent, restoreIrisAgent } from '@renderer/lib/iris-agent-actions';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

export interface AgentHistoryDialogProps {
  anchor: IrisAgentAnchor | null;
  anchorName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentHistoryDialog({
  anchor,
  anchorName,
  open,
  onOpenChange,
}: AgentHistoryDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<IrisAgentHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const anchorKey = anchor ? `${anchor.kind}:${anchor.path}` : null;

  useEffect(() => {
    if (!open || !anchor) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listIrisAgentHistory(anchor)
      .then((next) => {
        if (!cancelled) setEntries(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `anchorKey` stands in for the anchor object so a re-render with an equal
    // anchor does not reload the list.
  }, [open, anchorKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const runAction = async (
    entry: IrisAgentHistoryEntry,
    action: (sessionId: string) => Promise<IrisAgentSessionInfo | null>,
  ): Promise<void> => {
    setPendingId(entry.id);
    try {
      const result = await action(entry.id);
      if (result) onOpenChange(false);
    } finally {
      setPendingId(null);
    }
  };

  if (!anchor) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            {t('layout.agentHistoryTitle', { name: anchorName })}
          </DialogTitle>
          <DialogDescription>{t('layout.agentHistoryDescription')}</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            {t('common.loading')}
          </div>
        )}

        {!loading && error && (
          <p className="py-4 text-sm text-destructive">{error}</p>
        )}

        {!loading && !error && entries.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('layout.agentHistoryEmpty')}
          </p>
        )}

        {!loading && !error && entries.length > 0 && (
          <ul className="max-h-[55vh] divide-y overflow-y-auto rounded-md border">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 px-3 py-2.5">
                <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{entry.displayName}</span>
                    <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {entry.closed ? t('layout.agentHistoryClosed') : t('layout.agentHistoryLive')}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="shrink-0">{formatTimestamp(entry.updatedAt)}</span>
                    <span className="shrink-0">
                      {t('layout.agentHistoryIntentCount', { count: entry.intentCount })}
                    </span>
                    {entry.lastUserMessage && (
                      <span className="min-w-0 truncate">{entry.lastUserMessage}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={pendingId !== null}
                    onClick={() => {
                      void runAction(entry, reopenIrisAgent).catch(() => undefined);
                    }}
                  >
                    {t('layout.agentHistorySwitch')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={canRestoreHistoryEntry(entry)
                      ? t('layout.agentHistoryOpenNew')
                      : t('layout.agentHistoryStopBeforeRestore')}
                    disabled={pendingId !== null || !canRestoreHistoryEntry(entry)}
                    onClick={() => {
                      void runAction(entry, restoreIrisAgent).catch(() => undefined);
                    }}
                  >
                    <Plus className="!size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function canRestoreHistoryEntry(entry: IrisAgentHistoryEntry): boolean {
  if (entry.closed) return true;
  return entry.state !== 'starting' && entry.state !== 'running' &&
    entry.state !== 'waiting-tool' && entry.state !== 'retry-wait' && entry.state !== 'stopping';
}
