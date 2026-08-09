import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';

export function CommitBox({
  message,
  onMessageChange,
  onCommit,
  stagedCount,
  pending,
}: {
  message: string;
  onMessageChange: (msg: string) => void;
  onCommit: () => void;
  stagedCount: number;
  pending: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);

  const canCommit = message.trim().length > 0 && stagedCount > 0 && !pending;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit) {
        e.preventDefault();
        onCommit();
      }
    },
    [canCommit, onCommit],
  );

  return (
    <div className="shrink-0 border-b border-subtle px-3 py-2">
      <div className="relative">
        <textarea
          ref={ref}
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('git.commitPlaceholder')}
          rows={3}
          className={cn(
            'w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-xs leading-relaxed',
            'placeholder:text-muted-foreground/50',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          {stagedCount > 0
            ? t('git.stagedCount', { count: stagedCount })
            : t('git.stageFirst')}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              disabled={!canCommit}
              variant="default"
              size="sm"
              className="h-7 gap-1 px-3 text-xs"
              onClick={onCommit}
            >
              <Check className="!size-3.5" />
              {t('git.commit')}
            </Button>
          </TooltipTrigger>
          <TooltipContent className="text-xs">Ctrl+Enter</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
