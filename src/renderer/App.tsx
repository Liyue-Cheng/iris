import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { TitleBar } from '@renderer/components/layout/TitleBar';
import { ThreePane } from '@renderer/components/layout/ThreePane';
import { CreateDocDialog } from '@renderer/components/doc/CreateDocDialog';
import { DeleteDocDialog } from '@renderer/components/doc/DeleteDocDialog';
import { SettingsView, useSettingsViewOpen } from '@renderer/components/settings/SettingsView';

export function App(): JSX.Element {
  // Settings is a view, not a modal (Marina CP-4 decision): it replaces the
  // three-pane body; TitleBar stays for the drag region and window controls.
  const settingsOpen = useSettingsViewOpen();

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="min-h-0 flex-1">{settingsOpen ? <SettingsView /> : <ThreePane />}</div>
      </div>
      <CreateDocDialog />
      <DeleteDocDialog />
    </TooltipProvider>
  );
}
