import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { initSettingsStore } from './stores/settings-store';
import { hydrateSessions } from './stores/session-store';
import { editorStore } from './stores/editor-store';
import { wireInterrupts } from './cpu/interrupts';
import { openProject } from './lib/project-actions';
import { CHANNELS, EVENTS } from '@shared/protocol';
import type { WindowBootstrapState } from '@shared/types';
import { projectStore } from './stores/project-store';

async function bootstrap(): Promise<void> {
  // Dev-only: the front-cpu instruction console (separate debug entry, zero
  // production cost). Importing it initializes the logging provider; every
  // dispatch then prints payload/response/stage-timing to DevTools.
  if (import.meta.env.DEV) {
    const { cpuConsole } = await import('front-cpu/debug');
    cpuConsole.setLocale('zh-CN');
  }

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

  // Open the project THIS window is bound to (main is the authority on the
  // window→project binding; multi-window, each window gets its own root).
  // Failures surface in-app.
  if (!bootstrapState.activeScope && bootstrapState.requestedRoot) {
    void openProject(bootstrapState.requestedRoot);
  }
}

void bootstrap();
