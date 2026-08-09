import type {
  ProjectCommandRunResult,
  ProjectSettingsSnapshot,
  ProjectToolbarAction,
} from '@shared/types';
import { pipeline } from '@renderer/cpu';
import { confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { editorStore } from '@renderer/stores/editor-store';
import { projectStore } from '@renderer/stores/project-store';
import { getLastTerminalDims } from '@renderer/stores/session-store';
import { translate } from '@renderer/i18n';

export async function runProjectToolbarAction(
  actionIndex: number,
  action: ProjectToolbarAction,
  snapshot: ProjectSettingsSnapshot,
): Promise<void> {
  if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return;

  let approveRevision: string | undefined;
  if (!snapshot.trusted) {
    const root = projectStore.get().scope?.root;
    if (!root) return;
    const approved = await confirmDialog({
      title: translate('projectSettings.trustTitle'),
      message: translate('projectSettings.trustMessage', {
        description: action.description,
        command: action.command,
        root,
        terminal: translate(
          action.terminal === 'iris'
            ? 'projectSettings.irisTerminal'
            : 'projectSettings.systemTerminal',
        ),
      }),
      confirmText: translate('projectSettings.trustAndRun'),
    });
    if (!approved) return;
    approveRevision = snapshot.revision;
  }

  if (action.terminal === 'iris' && !(await projectStore.selectRoot())) return;
  const { cols, rows } = getLastTerminalDims(projectStore.get().scan?.projectRoot, {
    kind: 'root-hub',
  });
  const result = await pipeline.dispatch<
    {
      actionIndex: number;
      revision: string;
      approveRevision?: string;
      cols: number;
      rows: number;
    },
    ProjectCommandRunResult
  >('project-command.run', {
    actionIndex,
    revision: snapshot.revision,
    ...(approveRevision ? { approveRevision } : {}),
    cols,
    rows,
  });
  if (result.kind === 'iris') await projectStore.activateSession(result.session.id);
}
