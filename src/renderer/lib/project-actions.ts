/**
 * Imperative UI actions for project lifecycle. The verbs themselves are
 * instructions; this module only sequences UI affordances (folder picker,
 * loading phase, error surface) around pipeline.dispatch.
 */
import { CHANNELS } from '@shared/protocol';
import { pipeline } from '@renderer/cpu';
import { projectStore } from '@renderer/stores/project-store';
import { sessionStore } from '@renderer/stores/session-store';
import { hydrateIrisAgentSessions, irisAgentStore } from '@renderer/stores/iris-agent-store';
import { editorStore } from '@renderer/stores/editor-store';
import { alertDialog, confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { gitStore } from '@renderer/stores/git-store';
import { translate } from '@renderer/i18n';
import type { SoftwarePromptState } from '@shared/types';
import type { ProjectScope } from '@shared/types';
import { healthStore } from '@renderer/stores/health-store';
import { attemptAction, runUserAction } from './action-runtime';

async function loadPromptState(scope: ProjectScope): Promise<SoftwarePromptState> {
  return window.api.invoke<
    { expectedScope: ProjectScope },
    SoftwarePromptState
  >(CHANNELS.SOFTWARE_PROMPT_STATE, { expectedScope: scope });
}

function recordPromptHealth(scope: ProjectScope, promptState: SoftwarePromptState): void {
  const softwareDrift = promptState.entries.filter((entry) => entry.state !== 'ok');
  const projectDrift = promptState.project.entries.filter((entry) => entry.state !== 'synced');
  if (softwareDrift.length === 0 && projectDrift.length === 0) {
    healthStore.resolve('prompt-projection', scope);
    return;
  }
  const repairable =
    promptState.project.state !== 'conflict' &&
    promptState.project.state !== 'invalid-settings';
  const issues = [
    ...softwareDrift.map((entry) => ({
      layer: 'software' as const,
      path: entry.path,
      state: entry.state,
    })),
    ...projectDrift.map((entry) => ({
      layer: 'project' as const,
      path: entry.path,
      state: entry.state,
    })),
  ];
  const canAutoRepair = repairable;
  healthStore.degrade({
    key: 'prompt-projection',
    domain: 'prompt-projection',
    scope,
    cause: {
      domain: 'prompt',
      code: 'PromptNotReady',
      message: translate('errors.promptNotReadyTitle'),
      retryable: canAutoRepair,
      details: { repairable: canAutoRepair, issues },
    },
    ...(canAutoRepair ? {
      retry: async () => {
        await pipeline.dispatch('prompt.sync-all', {});
        recordPromptHealth(scope, await loadPromptState(scope));
      },
    } : {}),
  });
}

export async function refreshPromptProjectionHealth(): Promise<void> {
  const scope = projectStore.get().scope;
  if (!scope) return;
  const outcome = await attemptAction(() => loadPromptState(scope));
  if (outcome.status === 'ok') {
    recordPromptHealth(scope, outcome.value);
  } else if (outcome.status === 'failed') {
    healthStore.degrade({
      key: 'prompt-projection',
      domain: 'prompt-projection',
      cause: outcome.error,
      scope,
      retry: async () => recordPromptHealth(scope, await loadPromptState(scope)),
    });
  }
}

/** Audit both static projections after a project is active and offer one repair. */
export async function offerPromptProjectionRepair(): Promise<void> {
  const scope = projectStore.get().scope;
  if (!scope) return;
  const outcome = await attemptAction(() => loadPromptState(scope));
  if (outcome.status !== 'ok') {
    await refreshPromptProjectionHealth();
    return;
  }
  const promptState = outcome.value;
  recordPromptHealth(scope, promptState);
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
  if (confirmed) {
    await runUserAction(
      {
        title: translate('errors.promptSyncFailed'),
        dedupeKey: 'prompt:sync-all',
      },
      async () => {
        await pipeline.dispatch('prompt.sync-all', {});
        recordPromptHealth(scope, await loadPromptState(scope));
      },
    );
  }
}

export async function openProject(root: string): Promise<void> {
  const currentRoot = projectStore.get().scan?.projectRoot ?? null;
  const switchingRoot = currentRoot !== null && currentRoot !== root;
  const activeAgentSessions = irisAgentStore.get().sessions;
  if (switchingRoot && (sessionStore.get().sessions.length > 0 || activeAgentSessions.length > 0)) {
    const sessions = sessionStore.get().sessions;
    const live = sessions.filter((session) => session.state !== 'exited').length +
      activeAgentSessions.filter((session) =>
        session.state !== 'idle' && session.state !== 'ready' && session.state !== 'paused').length;
    const confirmed = await confirmDialog({
      title: translate('layout.switchTitle'),
      message: live > 0
        ? translate('layout.switchMessage', { count: sessions.length, live })
        : translate('layout.switchMessageNoneLive', { count: sessions.length + activeAgentSessions.length }),
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
    await hydrateIrisAgentSessions();
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
  await runUserAction(
    { title: translate('layout.switchFailed'), dedupeKey: 'project:pick-open' },
    async () => {
      const root = await window.api.invoke<undefined, string | null>(CHANNELS.DIALOG_PICK_FOLDER);
      if (root) await openProject(root);
    },
  );
}

/**
 * Open a project in a NEW window (VS Code "Open Folder in New Window"). Main
 * shows the folder picker and creates the window; this window is untouched.
 * Pass a root to skip the picker (e.g. an in-tree "open in new window" gesture).
 */
export async function openProjectInNewWindow(root?: string): Promise<void> {
  await runUserAction(
    { title: translate('layout.switchFailed'), dedupeKey: 'project:open-new-window' },
    () => pipeline.dispatch('window.open-project', root ? { root } : {}),
  );
}
