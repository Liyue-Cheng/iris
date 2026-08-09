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
import { translate } from '@renderer/i18n';
import type { SoftwarePromptState } from '@shared/types';

/** Audit both static projections after a project is active and offer one repair. */
export async function offerPromptProjectionRepair(): Promise<void> {
  const scope = projectStore.get().scope;
  if (!scope) return;
  const promptState = await window.api.invoke<
    { expectedScope: typeof scope },
    SoftwarePromptState
  >(CHANNELS.SOFTWARE_PROMPT_STATE, { expectedScope: scope });
  const softwareDrift = promptState.entries.filter((entry) => entry.state !== 'ok');
  const projectDrift = promptState.project.entries.filter((entry) => entry.state !== 'synced');
  const repairable =
    promptState.project.state !== 'conflict' &&
    promptState.project.state !== 'invalid-settings';
  if (!repairable || (softwareDrift.length === 0 && projectDrift.length === 0)) return;

  const affected = [...new Set([
    ...softwareDrift.map((entry) => entry.path),
    ...projectDrift.map((entry) => entry.path),
  ])];
  const confirmed = await confirmDialog({
    title: translate('settings.syncRequiredTitle'),
    message: translate('settings.syncRequiredMessage', {
      count: affected.length,
      files: affected.join('\n'),
    }),
    confirmText: translate('settings.resyncAll'),
  });
  if (confirmed) await pipeline.dispatch('prompt.sync-all', {});
}

export async function openProject(root: string): Promise<void> {
  const currentRoot = projectStore.get().scan?.projectRoot ?? null;
  const switchingRoot = currentRoot !== null && currentRoot !== root;
  if (switchingRoot && sessionStore.get().sessions.length > 0) {
    const sessions = sessionStore.get().sessions;
    const live = sessions.filter((session) => session.state !== 'exited').length;
    const confirmed = await confirmDialog({
      title: translate('layout.switchTitle'),
      message: live > 0
        ? translate('layout.switchMessage', { count: sessions.length, live })
        : translate('layout.switchMessageNoneLive', { count: sessions.length }),
      confirmText: translate('layout.closeAndSwitch'),
      tone: 'destructive',
    });
    if (!confirmed) return;
  }

  projectStore.markOpening();
  gitStore.reset();
  try {
    await editorStore.flushBeforeProjectSwitch();
    await pipeline.dispatch('project.open', { root });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    projectStore.handleOpenFailed(message);
    void alertDialog({ title: translate('layout.switchFailed'), message });
    return;
  }

  try {
    await offerPromptProjectionRepair();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void alertDialog({ title: translate('settings.syncRequiredTitle'), message });
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
