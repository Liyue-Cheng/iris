/**
 * Middle pane dispatcher — the two levels of 软件定义书 §5: type-level
 * collection views vs the single-doc view.
 */
import { useProject } from '@renderer/stores/project-store';
import { DocView } from '@renderer/components/doc/DocView';
import { IssuePanel } from '@renderer/components/collection/IssuePanel';
import { StatusList } from '@renderer/components/collection/StatusList';
import { ReportTimeline } from '@renderer/components/collection/ReportTimeline';
import { SimpleList } from '@renderer/components/collection/SimpleList';
import { TodoPanel } from '@renderer/components/collection/TodoPanel';

export function MiddlePane(): JSX.Element {
  const { view, scan, phase } = useProject();

  if (phase === 'ready' && scan?.root) {
    if (view.kind === 'todos') {
      return <TodoPanel root={scan.root} workspacePath={view.workspacePath} />;
    }
    if (view.kind === 'collection') {
      const { root } = scan;
      if (view.type === 'issue') return <IssuePanel root={root} workspacePath={view.workspacePath} />;
      if (view.type === 'status') return <StatusList root={root} workspacePath={view.workspacePath} />;
      if (view.type === 'report')
        return <ReportTimeline root={root} workspacePath={view.workspacePath} />;
      return <SimpleList root={root} type={view.type} workspacePath={view.workspacePath} />;
    }
  }

  return <DocView />;
}
