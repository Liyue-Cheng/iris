import { AlertCircle, Info, X } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import {
  dismissNotification,
  useNotifications,
} from '@renderer/stores/notification-store';
import { translate } from '@renderer/i18n';

export function NotificationHost(): JSX.Element | null {
  const notifications = useNotifications();
  if (notifications.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
    >
      {notifications.slice(0, 3).map((notification) => {
        const Icon = notification.level === 'error' ? AlertCircle : Info;
        return (
          <div
            key={notification.id}
            role={notification.level === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <div className="flex items-start gap-2.5">
              <Icon
                className={
                  notification.level === 'error'
                    ? 'mt-0.5 h-4 w-4 shrink-0 text-destructive'
                    : 'mt-0.5 h-4 w-4 shrink-0 text-primary'
                }
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 break-words text-sm font-medium">
                    {notification.title}
                    {notification.occurrences > 1 && (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        x{notification.occurrences}
                      </span>
                    )}
                  </p>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="-mr-1 -mt-1 h-7 w-7 shrink-0"
                    onClick={() => dismissNotification(notification.id)}
                    title={translate('common.close')}
                    aria-label={translate('common.close')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {notification.message}
                </p>
                {(notification.incidentId || notification.action) && (
                  <div className="mt-2 flex min-h-7 items-center gap-2">
                    {notification.incidentId && (
                      <code className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                        {notification.incidentId.slice(0, 8)}
                      </code>
                    )}
                    {notification.action && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-auto h-7"
                        onClick={() => notification.action?.run()}
                      >
                        {notification.action.label}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
