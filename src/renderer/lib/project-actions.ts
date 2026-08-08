/**
 * Imperative UI actions for project lifecycle. The verbs themselves are
 * instructions; this module only sequences UI affordances (folder picker,
 * loading phase, error surface) around pipeline.dispatch.
 */
import { CHANNELS } from '@shared/protocol';
import { pipeline } from '@renderer/cpu';
import { projectStore } from '@renderer/stores/project-store';
import { sessionStore } from '@renderer/stores/session-store';
import { editorStore } from '@renderer/stores/editor-store';
import { alertDialog, confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { gitStore } from '@renderer/stores/git-store';

export async function openProject(root: string): Promise<void> {
  const currentRoot = projectStore.get().scan?.projectRoot ?? null;
  const switchingRoot = currentRoot !== null && currentRoot !== root;
  if (switchingRoot && sessionStore.get().sessions.length > 0) {
    const sessions = sessionStore.get().sessions;
    const live = sessions.filter((session) => session.state !== 'exited').length;
    const confirmed = await confirmDialog({
      title: '切换项目',
      message:
        `切换会关闭当前项目的 ${sessions.length} 个终端会话` +
        (live > 0 ? `，其中 ${live} 个仍在运行。` : '。'),
      confirmText: '关闭并切换',
      tone: 'destructive',
    });
    if (!confirmed) return;
  }

  projectStore.markOpening();
  gitStore.reset();
  try {
    await editorStore.flushBeforeProjectSwitch();
    await pipeline.dispatch('project.open', { root });
    // store update happens in the instruction's commit
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    projectStore.handleOpenFailed(message);
    void alertDialog({ title: '项目切换失败', message });
  }
}

/** Native folder picker → open in THIS window. No-op when the user cancels. */
export async function pickAndOpenProject(): Promise<void> {
  const root = await window.api.invoke<undefined, string | null>(CHANNELS.DIALOG_PICK_FOLDER);
  if (root) await openProject(root);
}

/**
 * Open a project in a NEW window (VS Code "Open Folder in New Window"). Main
 * shows the folder picker and creates the window; this window is untouched.
 * Pass a root to skip the picker (e.g. an in-tree "open in new window" gesture).
 */
export async function openProjectInNewWindow(root?: string): Promise<void> {
  await pipeline.dispatch('window.open-project', root ? { root } : {});
}
