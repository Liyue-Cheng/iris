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
import { useProject } from '@renderer/stores/project-store';

export function ThreePane(): JSX.Element {
  const { view } = useProject();
  // Round-4 E3: collection / todo views are the "manager" — there is no
  // terminal anchor, so drop the right pane and let the manager take the
  // freed width. Only the single-doc and project-root views keep a terminal.
  // Equal-width left/right (D3) when the terminal is present.
  const showTerminal = view.kind === 'doc' || view.kind === 'root';

  if (!showTerminal) {
    return (
      <ResizablePanelGroup direction="horizontal" autoSaveId="iris-two-pane">
        <ResizablePanel defaultSize={25} minSize={12}>
          <LeftPane />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={75} minSize={30}>
          <MiddlePane />
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="iris-three-pane-v2">
      <ResizablePanel defaultSize={25} minSize={12}>
        <LeftPane />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={50} minSize={25}>
        <MiddlePane />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={25} minSize={15}>
        <RightPane />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
