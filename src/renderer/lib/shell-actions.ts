import { pipeline } from '@renderer/cpu';
import { translate } from '@renderer/i18n';
import { runUserAction } from './action-runtime';

export async function openProjectItem(path: string): Promise<void> {
  await runUserAction(
    { title: translate('errors.shellOpenFailed'), dedupeKey: `shell:open:${path}` },
    () => pipeline.dispatch('shell.open-project-item', { path }),
  );
}

export async function revealProjectItem(path: string): Promise<void> {
  await runUserAction(
    { title: translate('errors.shellRevealFailed'), dedupeKey: `shell:reveal:${path}` },
    () => pipeline.dispatch('shell.reveal-project-item', { path }),
  );
}

export async function openExternalUrl(url: string): Promise<void> {
  await runUserAction(
    { title: translate('errors.shellOpenFailed'), dedupeKey: `shell:external:${url}` },
    () => pipeline.dispatch('shell.open-external-url', { url }),
  );
}
