/**
 * The shell (software-definition.md §5 界面):
 *   left   — lens-organized document tree (M1)
 *   middle — collection views / single-doc editor (M2/M4)
 *   right  — session panel, vertical AI conversations (M3)
 *
 * Outside the dedicated issue browser, the LEFT pane lives in ONE stable
 * outer panel group (autoSaveId
 * "iris-shell") that never remounts on a view switch — otherwise每切一次
 * view.kind 就换一整个 PanelGroup，左栏被迫套用那个组自己的宽度，点终端条
 * （root 视图）左宽就会跳。Only the RIGHT area's content swaps by view:
 * full-width terminal (root), editor+terminal split (doc), or a full-width
 * manager (collection/todos). The issue browser is a separate two-pane shell
 * so the global tree and terminal do not compete with its list and editor.
 */
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable';
import { LeftPane } from '@renderer/components/layout/LeftPane';
import { MiddlePane } from '@renderer/components/layout/MiddlePane';
import { RightPane } from '@renderer/components/layout/RightPane';
import { DocView } from '@renderer/components/doc/DocView';
import { useProject, type MiddleView } from '@renderer/stores/project-store';

/** The right area — its content depends on the view, but the left pane's
 *  width never does (the left lives in the stable outer group above). */
function RightArea({ view }: { view: MiddleView }): JSX.Element {
  // Collection / todo views keep the manager at full width.
  if (view.kind === 'collection' || view.kind === 'todos') {
    return <MiddlePane />;
  }

  // Doc (editor + terminal split) and hub (terminal-only) views share ONE
  // panel group with a STABLE RightPane panel. If RightPane changed tree
  // position/type between views (as it used to — wrapped in a group for doc,
  // bare for hub), React would unmount+remount it on every cross-view switch,
  // needlessly tearing down the live xterm and re-replaying even when the same
  // session stays anchored. The editor panel only renders for doc view;
  // RightPane keeps the same id/position either way, so its terminal survives a
  // doc↔hub switch. (Same philosophy as the LeftPane staying in the stable
  // outer group.)
  const isDoc = view.kind === 'doc';
  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="iris-doc-split">
      {isDoc && (
        <>
          <ResizablePanel id="doc-editor" order={1} defaultSize={64} minSize={30}>
            <MiddlePane />
          </ResizablePanel>
          <ResizableHandle />
        </>
      )}
      <ResizablePanel id="doc-terminal" order={2} defaultSize={isDoc ? 36 : 100} minSize={20}>
        <RightPane />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

export function ThreePane(): JSX.Element {
  const { view } = useProject();

  if (view.kind === 'collection' && view.type === 'issue') {
    return (
      <ResizablePanelGroup direction="horizontal" autoSaveId="iris-issue-browser">
        <ResizablePanel id="issue-list" order={1} defaultSize={40} minSize={28} maxSize={58}>
          <MiddlePane />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="issue-document" order={2} defaultSize={60} minSize={38}>
          <DocView />
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

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
