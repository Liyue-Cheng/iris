import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './button';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';
import { healthStore, useHealthIssues } from '@renderer/stores/health-store';
import { translate } from '@renderer/i18n';
import type { HealthDomain } from '@shared/app-error';

const HEALTH_LABEL: Record<HealthDomain, Parameters<typeof translate>[0]> = {
  system: 'health.system',
  'project-watcher': 'health.projectWatcher',
  'project-projection': 'health.projectProjection',
  'git-watcher': 'health.gitWatcher',
  'git-projection': 'health.gitProjection',
  'session-projection': 'health.sessionProjection',
  'prompt-projection': 'health.promptProjection',
};

export function HealthBanner(): JSX.Element | null {
  const issues = useHealthIssues();
  const issue = issues[0];
  if (!issue) return null;
  const label = translate(HEALTH_LABEL[issue.domain]);
  const details = `${label}: ${issue.error.message}`;

  return (
    <div
      role="alert"
      className="app-region-no-drag flex min-w-0 max-w-[min(42vw,32rem)] items-center gap-1.5 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 truncate" aria-label={details}>
            <span className="font-medium">{label}</span>
            <span className="text-muted-foreground">: {issue.error.message}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-md break-words">{details}</TooltipContent>
      </Tooltip>
      {issues.length > 1 && (
        <span className="shrink-0 text-muted-foreground">+{issues.length - 1}</span>
      )}
      {issue.retry && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              disabled={issue.state === 'recovering'}
              aria-label={translate('health.retry')}
              onClick={() => void healthStore.retry(issue)}
            >
              <RefreshCw className={issue.state === 'recovering' ? 'animate-spin' : ''} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{translate('health.retry')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
