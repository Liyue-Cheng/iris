import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { GROUP_BAR } from '@renderer/components/collection/parts/layout';
import { gitStore, type GitResource, type GitResourceGroup } from '@renderer/stores/git-store';
import { ResourceRow } from './ResourceRow';

const GROUP_LABELS: Record<GitResourceGroup, 'git.merge' | 'git.index' | 'git.workingTree' | 'git.untracked'> = {
  merge: 'git.merge',
  index: 'git.index',
  workingTree: 'git.workingTree',
  untracked: 'git.untracked',
};

export function ResourceGroup({
  kind,
  resources,
  pending,
}: {
  kind: GitResourceGroup;
  resources: GitResource[];
  pending: boolean;
}): JSX.Element | null {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  if (resources.length === 0) return null;

  const staged = kind === 'index';

  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className={cn(GROUP_BAR, 'group/hdr w-full hover:bg-card/80')}
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
        )}
        <span className="truncate font-medium text-foreground/80">
          {t(GROUP_LABELS[kind])}
        </span>
        <span className="shrink-0 text-muted-foreground/70">{resources.length}</span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/hdr:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                disabled={pending}
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={(e) => {
                  e.stopPropagation();
                  void (staged
                    ? gitStore.unstage(resources.map((r) => r.path))
                    : gitStore.stage(resources.map((r) => r.path)));
                }}
              >
                {staged ? (
                  <Minus className="!size-3" />
                ) : (
                  <Plus className="!size-3" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">
              {staged ? t('git.unstageAll') : t('git.stageAll')}
            </TooltipContent>
          </Tooltip>
        </span>
      </button>

      {!collapsed &&
        resources.map((r) => (
          <ResourceRow
            key={`${kind}:${r.path}`}
            resource={r}
            group={kind}
            pending={pending}
          />
        ))}
    </div>
  );
}
