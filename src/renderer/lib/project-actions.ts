/**
 * Imperative UI actions for project lifecycle. The verbs themselves are
 * instructions; this module only sequences UI affordances (folder picker,
 * loading phase, error surface) around pipeline.dispatch.
 */
import { CHANNELS } from '@shared/protocol';
import { pipeline } from '@renderer/cpu';
import { projectStore } from '@renderer/stores/project-store';

export async function openProject(root: string): Promise<void> {
  projectStore.markOpening();
  try {
    await pipeline.dispatch('project.open', { root });
    // store update happens in the instruction's commit
  } catch (err) {
    projectStore.handleOpenFailed(err instanceof Error ? err.message : String(err));
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
  await window.api.invoke<{ root?: string }, { opened: boolean }>(
    CHANNELS.WINDOW_OPEN_PROJECT,
    root ? { root } : undefined,
  );
}
