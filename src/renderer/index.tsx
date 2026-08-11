import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { initSettingsStore } from './stores/settings-store';
import { hydrateSessions } from './stores/session-store';
import { editorStore } from './stores/editor-store';
import { wireInterrupts } from './cpu/interrupts';
import { offerPromptProjectionRepair, openProject } from './lib/project-actions';
import { CHANNELS, EVENTS } from '@shared/protocol';
import type { WindowBootstrapState } from '@shared/types';
import { projectStore } from './stores/project-store';
import { hydrateProjectSettings } from './stores/project-settings-store';
import { normalizeUiError } from './lib/action-runtime';
import { notify } from './stores/notification-store';
import { translate } from './i18n';

function installGlobalErrorFallbacks(): void {
  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    const error = normalizeUiError(event.reason);
    console.error('[renderer] unhandled rejection', event.reason);
    notify({
      dedupeKey: `renderer:unhandled:${error.message}`,
      title: translate('errors.unhandledTitle'),
      message: error.message,
      sticky: true,
      domain: error.domain,
      ...(error.incidentId ? { incidentId: error.incidentId } : {}),
    });
  });
  window.addEventListener('error', (event) => {
    const error = normalizeUiError(event.error ?? event.message);
    console.error('[renderer] uncaught error', event.error ?? event.message);
    notify({
      dedupeKey: `renderer:uncaught:${error.message}`,
      title: translate('errors.unhandledTitle'),
      message: error.message,
      sticky: true,
      domain: error.domain,
    });
  });
}

function renderBootstrapFailure(cause: unknown): void {
  const error = normalizeUiError(cause);
  console.error('[renderer] bootstrap failed', cause);
  const container = document.getElementById('root');
  if (!container) return;
  container.replaceChildren();
  const main = document.createElement('main');
  main.setAttribute('role', 'alert');
  main.style.cssText = 'display:flex;height:100%;align-items:center;justify-content:center;padding:24px;font-family:system-ui';
  const section = document.createElement('section');
  section.style.cssText = 'width:100%;max-width:520px';
  const title = document.createElement('h1');
  title.textContent = translate('errors.bootstrapFailedTitle');
  title.style.cssText = 'font-size:18px;margin:0 0 10px';
  const message = document.createElement('p');
  message.textContent = error.message;
  message.style.cssText = 'font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;opacity:.75';
  const incident = document.createElement('code');
  incident.textContent = error.incidentId ?? crypto.randomUUID();
  incident.style.cssText = 'display:block;margin-top:12px;font-size:12px;opacity:.65';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = translate('errors.reload');
  retry.style.cssText = 'margin-top:16px;padding:8px 12px;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit';
  retry.addEventListener('click', () => window.location.reload());
  section.append(title, message, incident, retry);
  main.append(section);
  container.append(main);
}

async function bootstrap(): Promise<void> {
  // Settings (theme included) load before first paint — no flash of the
  // wrong theme; index.html's static data-theme covers the load gap.
  await initSettingsStore();

  wireInterrupts();

  // A conflict or write failure rejects the close handshake and leaves the
  // document mounted for recovery.
  window.api.on(EVENTS.APP_FLUSH_BEFORE_QUIT, () => {
    void editorStore
      .flushBeforeSwitch('before-quit')
      .then((ok) => window.api.invoke(CHANNELS.APP_FLUSH_DONE, { ok }))
      .catch(() => window.api.invoke(CHANNELS.APP_FLUSH_DONE, { ok: false }));
  });
  const bootstrapState = await window.api.invoke<undefined, WindowBootstrapState>(
    CHANNELS.WINDOW_BOOTSTRAP,
  );
  if (bootstrapState.activeScope) {
    await projectStore.restoreActive(bootstrapState.activeScope);
    await hydrateProjectSettings();
    // Session projection is event-fed; reloads recover the still-live pool
    // without replaying project.open and restarting project backends.
    await hydrateSessions();
  }

  const container = document.getElementById('root');
  if (!container) throw new Error('#root not found');
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  if (bootstrapState.activeScope) void offerPromptProjectionRepair();

  // Open the project THIS window is bound to (main is the authority on the
  // window→project binding; multi-window, each window gets its own root).
  // Failures surface in-app.
  if (!bootstrapState.activeScope && bootstrapState.requestedRoot) {
    void openProject(bootstrapState.requestedRoot);
  }
}

installGlobalErrorFallbacks();
void bootstrap().catch(renderBootstrapFailure);
