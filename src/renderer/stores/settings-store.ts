/**
 * @file stores/settings-store.ts
 * @purpose Renderer-side settings projection. CQRS boundary
 *   (technical-design.md): this store only REFLECTS the world — initial load
 *   via the bridge + evt:settings:changed broadcasts. CHANGING settings goes
 *   through the pipeline (`settings.update` instruction), never through this
 *   file.
 *
 * Applying appearance (data-theme attribute, font variable) lives here too:
 * projecting state onto the DOM is part of reflecting the world.
 */
import { useSyncExternalStore } from 'react';
import type { Settings, SettingsChangedEvent } from '@shared/types';
import { CHANNELS, EVENTS } from '@shared/protocol';

let settings: Settings | null = null;
const subscribers = new Set<() => void>();

function emit(): void {
  subscribers.forEach((cb) => cb());
}

function applyAppearance(s: Settings): void {
  document.documentElement.dataset.theme = s.appearance.theme;
  document.body.style.setProperty('--ui-font-family', s.appearance.uiFontFamily);
}

function setSettings(next: Settings): void {
  settings = next;
  applyAppearance(next);
  emit();
}

/** Load once at startup, then follow main-process broadcasts. */
export async function initSettingsStore(): Promise<void> {
  const initial = await window.api.invoke<undefined, Settings>(CHANNELS.SETTINGS_GET);
  setSettings(initial);
  window.api.on<SettingsChangedEvent>(EVENTS.SETTINGS_CHANGED, (event) => {
    setSettings(event.settings);
  });
}

export function getSettings(): Settings | null {
  return settings;
}

export function useSettings(): Settings | null {
  return useSyncExternalStore(
    (onStoreChange) => {
      subscribers.add(onStoreChange);
      return () => {
        subscribers.delete(onStoreChange);
      };
    },
    () => settings,
  );
}
