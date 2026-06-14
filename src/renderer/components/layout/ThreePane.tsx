/**
 * The shell (software-definition.md §5 界面):
 *   left   — lens-organized document tree (M1)
 *   middle — collection views / single-doc editor (M2/M4)
 *   right  — session panel, vertical AI conversations (M3)
 *
 * The LEFT pane lives in ONE stable outer panel group (autoSaveId
 * "iris-shell") that never remounts on a view switch — otherwise每切一次
 * view.kind 就换一整个 PanelGroup，左栏被迫套用那个组自己的宽度，点终端条
 * （root 视图）左宽就会跳。Only the RIGHT area's content swaps by view:
 * full-width terminal (root), editor+terminal split (doc), or the manager
 * (collection/todos).
 */
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable';
import { LeftPane } from '@renderer/components/layout/LeftPane';
import { MiddlePane } from '@renderer/components/layout/MiddlePane';
import { RightPane } from '@renderer/components/layout/RightPane';
import { useProject, type MiddleView } from '@renderer/stores/project-store';

/** The right area — its content depends on the view, but the left pane's
 *  width never does (the left lives in the stable outer group above). */
function RightArea({ view }: { view: MiddleView }): JSX.Element {
  // Single-doc view (D3): editor + terminal, their own split state.
  if (view.kind === 'doc') {
    return (
      <ResizablePanelGroup direction="horizontal" autoSaveId="iris-doc-split">
        <ResizablePanel defaultSize={64} minSize={30}>
          <MiddlePane />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={36} minSize={20}>
          <RightPane />
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }
  // Project-root view (主页重设计): terminal独占，no README.
  if (view.kind === 'root') {
    return <RightPane />;
  }
  // Collection / todo views (Round-4 E3): the manager takes the full width.
  return <MiddlePane />;
}

export function ThreePane(): JSX.Element {
  const { view } = useProject();
  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="iris-shell">
      <ResizablePanel defaultSize={25} minSize={12} maxSize={40}>
        <LeftPane />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={75} minSize={30}>
        <RightArea view={view} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
