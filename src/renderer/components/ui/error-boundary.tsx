import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@renderer/components/ui/button';
import { translate } from '@renderer/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  incidentId: string | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, incidentId: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, incidentId: crypto.randomUUID() };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] React tree failed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex h-full items-center justify-center bg-background p-6 text-foreground">
        <section role="alert" className="w-full max-w-lg">
          <h1 className="text-base font-semibold">{translate('errors.renderFailedTitle')}</h1>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {translate('errors.renderFailedMessage')}
          </p>
          {this.state.incidentId && (
            <code className="mt-3 block text-xs text-muted-foreground">
              {this.state.incidentId}
            </code>
          )}
          <Button className="mt-4" onClick={() => window.location.reload()}>
            {translate('errors.reload')}
          </Button>
        </section>
      </main>
    );
  }
}
