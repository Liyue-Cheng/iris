import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { initSettingsStore, getSettings } from './stores/settings-store';
import { hydrateSessions } from './stores/session-store';
import { editorStore } from './stores/editor-store';
import { wireInterrupts } from './cpu/interrupts';
import { openProject } from './lib/project-actions';
import { installRendererPerfObservers } from './lib/perf-runtime';
import { CHANNELS, EVENTS } from '@shared/protocol';

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
  installRendererPerfObservers();

  // B3: on window close, main asks us to flush unsaved editor work (the
  // normal doc.save instruction), then we ack so main can finish closing.
  window.api.on(EVENTS.APP_FLUSH_BEFORE_QUIT, () => {
    void editorStore
      .save()
      .finally(() => void window.api.invoke(CHANNELS.APP_FLUSH_DONE));
  });
  // Session projection is event-fed; a renderer reload starts it empty
  // while the PTY pool lives on in main. Hydrate before first paint so
  // surviving sessions are visible (and closeable) immediately.
  await hydrateSessions();

  const container = document.getElementById('root');
  if (!container) throw new Error('#root not found');
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  // Reopen the last project after first paint; failures surface in-app.
  const lastRoot = getSettings()?.project.lastRoot;
  if (lastRoot) void openProject(lastRoot);
}

void bootstrap();
