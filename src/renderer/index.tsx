import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { initSettingsStore } from './stores/settings-store';

async function bootstrap(): Promise<void> {
  // Settings (theme included) load before first paint — no flash of the
  // wrong theme; index.html's static data-theme covers the load gap.
  await initSettingsStore();

  const container = document.getElementById('root');
  if (!container) throw new Error('#root not found');
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
