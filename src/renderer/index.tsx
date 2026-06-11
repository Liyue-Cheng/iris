import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { initSettingsStore, getSettings } from './stores/settings-store';
import { wireInterrupts } from './cpu/interrupts';
import { openProject } from './lib/project-actions';

async function bootstrap(): Promise<void> {
  // Settings (theme included) load before first paint — no flash of the
  // wrong theme; index.html's static data-theme covers the load gap.
  await initSettingsStore();
  wireInterrupts();

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
