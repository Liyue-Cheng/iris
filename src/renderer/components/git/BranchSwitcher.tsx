import { Check, ChevronsUpDown, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { gitStore } from '@renderer/stores/git-store';
import type { GitSnapshot } from '@shared/types';

export function BranchSwitcher({
  snapshot,
  pending,
}: {
  snapshot: GitSnapshot;
  pending: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const label = snapshot.branch ?? (snapshot.detached ? 'HEAD (detached)' : 'Git');
  const hasSync = snapshot.ahead > 0 || snapshot.behind > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          disabled={pending || snapshot.branches.length === 0}
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 max-w-[12rem] justify-start gap-1.5 px-1.5 text-xs font-medium"
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
          {hasSync && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {snapshot.ahead > 0 && `↑${snapshot.ahead}`}
              {snapshot.behind > 0 && `↓${snapshot.behind}`}
            </span>
          )}
          <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 max-w-[min(18rem,calc(100vw-2rem))] overflow-y-auto"
      >
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">
          {t('git.localBranches')}
        </DropdownMenuLabel>
        {snapshot.branches.map((branch) => (
          <DropdownMenuItem
            key={branch.name}
            disabled={pending || branch.current}
            onSelect={() => void gitStore.switchBranch(branch.name)}
            className="justify-between gap-4"
          >
            <span className="min-w-0 truncate" title={branch.name}>
              {branch.name}
            </span>
            {branch.current && <Check className="size-3.5 shrink-0 text-[var(--rp-foam)]" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
