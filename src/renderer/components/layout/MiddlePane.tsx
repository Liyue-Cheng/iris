/**
 * Middle pane dispatcher — the two levels of 软件定义书 §5: type-level
 * collection views vs the single-doc view.
 */
import { useProject } from '@renderer/stores/project-store';
import { DocView } from '@renderer/components/doc/DocView';
import { RootReadme } from '@renderer/components/doc/RootReadme';
import { IssuePanel } from '@renderer/components/collection/IssuePanel';
import { SimpleList } from '@renderer/components/collection/SimpleList';
import { TodoPanel } from '@renderer/components/collection/TodoPanel';

export function MiddlePane(): JSX.Element {
  const { view, scan, phase } = useProject();

  if (phase === 'ready' && scan?.root) {
    if (view.kind === 'root') {
      return <RootReadme />;
    }
    if (view.kind === 'todos') {
      return <TodoPanel root={scan.root} workspacePath={view.workspacePath} />;
    }
    if (view.kind === 'collection') {
      if (view.type === 'issue') {
        return <IssuePanel root={scan.root} workspacePath={view.workspacePath} />;
      }
      return <SimpleList root={scan.root} type={view.type} workspacePath={view.workspacePath} />;
    }
  }

  return <DocView />;
}
