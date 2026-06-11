/**
 * The three-pane shell (software-definition.md §5 界面):
 *   left   — lens-organized document tree (M1)
 *   middle — collection views / single-doc editor (M2/M4)
 *   right  — session panel, vertical AI conversations (M3)
 * M0 ships placeholders; the panel skeleton and proportions are the real
 * deliverable.
 */
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable';
import { LeftPane } from '@renderer/components/layout/LeftPane';
import { DocView } from '@renderer/components/doc/DocView';

function Placeholder({ title, note }: { title: string; note: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
      <div className="text-sm font-medium text-muted-foreground">{title}</div>
      <div className="max-w-48 text-xs text-muted-foreground/70">{note}</div>
    </div>
  );
}

export function ThreePane(): JSX.Element {
  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="iris-three-pane">
      <ResizablePanel defaultSize={20} minSize={12}>
        <LeftPane />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={50} minSize={25}>
        <DocView />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={30} minSize={15}>
        <div className="h-full bg-card/50">
          <Placeholder title="会话" note="M3：锚定于文档的终端会话" />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
