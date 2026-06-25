import { useEffect } from 'react';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { TitleBar } from '@renderer/components/layout/TitleBar';
import { ThreePane } from '@renderer/components/layout/ThreePane';
import { CreateDocDialog } from '@renderer/components/doc/CreateDocDialog';
import { DeleteDocDialog } from '@renderer/components/doc/DeleteDocDialog';
import { ConfirmDialog } from '@renderer/components/ui/confirm-dialog';
import { SettingsView, useSettingsViewOpen } from '@renderer/components/settings/SettingsView';
import { PerfPanel } from '@renderer/components/perf/PerfPanel';
import { focusStore } from '@renderer/stores/focus-store';

export function App(): JSX.Element {
  // Settings is a view, not a modal (Marina CP-4 decision): it replaces the
  // three-pane body; TitleBar stays for the drag region and window controls.
  const settingsOpen = useSettingsViewOpen();

  // P6: when the window regains focus with nothing meaningful focused (the
  // OS dropped focus on the body, e.g. after a launch pad or a closed dialog),
  // re-assert the last claimed region so the user can keep typing without a
  // click. Skip when something already holds focus — never yank it from where
  // the user clicked.
  useEffect(() => {
    const onFocus = (): void => {
      const el = document.activeElement;
      if (!el || el === document.body) focusStore.restore();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="min-h-0 flex-1">{settingsOpen ? <SettingsView /> : <ThreePane />}</div>
      </div>
      <CreateDocDialog />
      <DeleteDocDialog />
      <ConfirmDialog />
      <PerfPanel />
    </TooltipProvider>
  );
}
