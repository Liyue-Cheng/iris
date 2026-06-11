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
import { MiddlePane } from '@renderer/components/layout/MiddlePane';
import { RightPane } from '@renderer/components/layout/RightPane';

export function ThreePane(): JSX.Element {
  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="iris-three-pane">
      <ResizablePanel defaultSize={20} minSize={12}>
        <LeftPane />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={50} minSize={25}>
        <MiddlePane />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={30} minSize={15}>
        <RightPane />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
