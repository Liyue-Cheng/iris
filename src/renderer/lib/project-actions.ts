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

/** Native folder picker → open. No-op when the user cancels. */
export async function pickAndOpenProject(): Promise<void> {
  const root = await window.api.invoke<undefined, string | null>(CHANNELS.DIALOG_PICK_FOLDER);
  if (root) await openProject(root);
}
