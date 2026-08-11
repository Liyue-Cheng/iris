import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './button';
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
  return (
    <div role="alert" className="flex min-h-9 shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs">
      <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
      <span className="shrink-0 font-medium">
        {translate(HEALTH_LABEL[issue.domain])}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={issue.error.message}>
        {issue.error.message}
      </span>
      {issues.length > 1 && (
        <span className="shrink-0 text-muted-foreground">+{issues.length - 1}</span>
      )}
      {issue.retry && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          disabled={issue.state === 'recovering'}
          title={translate('health.retry')}
          onClick={() => void healthStore.retry(issue)}
        >
          <RefreshCw className={issue.state === 'recovering' ? 'animate-spin' : ''} />
        </Button>
      )}
    </div>
  );
}
