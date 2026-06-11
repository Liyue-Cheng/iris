import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { TitleBar } from '@renderer/components/layout/TitleBar';
import { ThreePane } from '@renderer/components/layout/ThreePane';
import { CreateDocDialog } from '@renderer/components/doc/CreateDocDialog';

export function App(): JSX.Element {
  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="min-h-0 flex-1">
          <ThreePane />
        </div>
      </div>
      <CreateDocDialog />
    </TooltipProvider>
  );
}
