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
import type { ComponentType } from 'react';
import type { DocType, IrisWorkspace } from '@shared/types';

interface DocumentCollectionPanelProps {
  root: IrisWorkspace;
  workspacePath: string | null;
  selectedPath: string | null;
}

function MiscPanel(props: DocumentCollectionPanelProps): JSX.Element {
  return <SimpleList {...props} type="misc" />;
}

const DOCUMENT_COLLECTION_PANELS = {
  issue: IssuePanel,
  status: StatusList,
  report: ReportTimeline,
  misc: MiscPanel,
} satisfies Record<DocType, ComponentType<DocumentCollectionPanelProps>>;

export function MiddlePane(): JSX.Element {
  const { view, scan, phase } = useProject();

  if (phase === 'ready' && scan?.root) {
    if (view.kind === 'todos') {
      return <TodoPanel root={scan.root} workspacePath={view.workspacePath} />;
    }
    if (view.kind === 'collection') {
      const Panel = DOCUMENT_COLLECTION_PANELS[view.type];
      return (
        <Panel
          key={`${view.type}\u0000${view.workspacePath ?? ''}`}
          root={scan.root}
          workspacePath={view.workspacePath}
          selectedPath={view.selectedPath}
        />
      );
    }
  }

  return <DocView />;
}
