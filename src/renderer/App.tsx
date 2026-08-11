import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { TitleBar } from '@renderer/components/layout/TitleBar';
import { ThreePane } from '@renderer/components/layout/ThreePane';
import { CreateDocDialog } from '@renderer/components/doc/CreateDocDialog';
import { DeleteDocDialog } from '@renderer/components/doc/DeleteDocDialog';
import {
  ActionDialog,
  AlertDialog,
  ConfirmDialog,
} from '@renderer/components/ui/confirm-dialog';
import { NotificationHost } from '@renderer/components/ui/notification-host';
import { AppErrorBoundary } from '@renderer/components/ui/error-boundary';
import { HealthBanner } from '@renderer/components/ui/health-banner';
import { SettingsView, useSettingsViewOpen } from '@renderer/components/settings/SettingsView';
import { WelcomeView } from '@renderer/components/project/WelcomeView';
import { useProject } from '@renderer/stores/project-store';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function App(): JSX.Element {
  const { t } = useTranslation();
  // Settings is a view, not a modal (Marina CP-4 decision): it replaces the
  // three-pane body; TitleBar stays for the drag region and window controls.
  const settingsOpen = useSettingsViewOpen();
  const { phase, scan } = useProject();

  return (
    <AppErrorBoundary>
    <TooltipProvider delayDuration={400} skipDelayDuration={0} disableHoverableContent>
      <div className="flex h-full flex-col">
        <TitleBar />
        <HealthBanner />
        <div className="min-h-0 flex-1">
          {settingsOpen ? (
            <SettingsView />
          ) : phase === 'opening' ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('app.switchingProject')}
            </div>
          ) : scan ? (
            <ThreePane />
          ) : (
            <WelcomeView />
          )}
        </div>
      </div>
      <CreateDocDialog />
      <DeleteDocDialog />
      <ConfirmDialog />
      <AlertDialog />
      <ActionDialog />
      <NotificationHost />
    </TooltipProvider>
    </AppErrorBoundary>
  );
}
