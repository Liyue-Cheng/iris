import { Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@renderer/lib/utils';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { gitStore, type GitResource, type GitResourceGroup } from '@renderer/stores/git-store';
import { effectiveChar, statusColor, statusLabel } from './git-status-style';

function splitPath(fullPath: string): { name: string; dir: string } {
  const sep = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
  if (sep < 0) return { name: fullPath, dir: '' };
  return { name: fullPath.slice(sep + 1), dir: fullPath.slice(0, sep) };
}

export function ResourceRow({
  resource,
  group,
  pending,
}: {
  resource: GitResource;
  group: GitResourceGroup;
  pending: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const staged = group === 'index';
  const char = effectiveChar(resource.status, group);
  const color = statusColor(resource.status, group);
  const label = statusLabel(resource.status, group);
  const { name, dir } = splitPath(resource.path);

  return (
    <div
      className="group grid h-8 items-center gap-1.5 border-b border-subtle/40 px-3 text-sm hover:bg-muted/50"
      style={{ gridTemplateColumns: '16px 1fr auto' }}
      title={`${resource.path} — ${label}`}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'flex size-4 items-center justify-center font-mono text-[11px] font-semibold',
              group === 'merge' && 'font-bold',
            )}
            style={{ color }}
          >
            {char}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          {label}
        </TooltipContent>
      </Tooltip>

      <span className="flex min-w-0 items-baseline gap-1">
        <span className="truncate text-sm">{name}</span>
        {dir && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{dir}</span>
        )}
      </span>

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              disabled={pending}
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() =>
                void (staged
                  ? gitStore.unstage([resource.path])
                  : gitStore.stage([resource.path]))
              }
            >
              {staged ? <Minus className="!size-3.5" /> : <Plus className="!size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left" className="text-xs">
            {staged ? t('git.unstage') : t('git.stage')}
          </TooltipContent>
        </Tooltip>
      </span>
    </div>
  );
}
