/**
 * @file stores/styles-store.ts
 * @purpose Projection store for the two style tables (status → template,
 *   label → template). Read side only: state arrives from STYLES_GET reads
 *   and the styles.update commit. Literal, case-sensitive lookup; anything
 *   unmapped resolves to the gray default template (键是硬的，值是软的 —
 *   graceful, not an error).
 */
import { useSyncExternalStore } from 'react';
import { CHANNELS } from '@shared/protocol';
import {
  DEFAULT_STYLE_MAPS,
  templateById,
  type BadgeTemplate,
  type StyleMaps,
  type StyleMapsState,
} from '@shared/style-maps';

let state: StyleMapsState = { maps: DEFAULT_STYLE_MAPS, source: 'builtin' };
const subscribers = new Set<() => void>();

function setState(next: StyleMapsState): void {
  state = next;
  subscribers.forEach((cb) => cb());
}

export const stylesStore = {
  get(): StyleMapsState {
    return state;
  },

  /** Re-read the effective maps (project open, fs change of styles.json). */
  async refresh(): Promise<void> {
    try {
      const next = await window.api.invoke<undefined, StyleMapsState>(CHANNELS.STYLES_GET);
      setState(next);
    } catch (err) {
      console.warn('[styles-store] refresh failed', err);
    }
  },

  /** Commit hook of styles.update. */
  handleUpdated(next: StyleMapsState): void {
    setState(next);
  },
};

export function useStyleMaps(): StyleMapsState {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    () => state,
  );
}

/** Resolve a status/label string to its template under the given maps. */
export function templateFor(
  maps: StyleMaps,
  kind: 'status' | 'label',
  key: string,
): BadgeTemplate {
  return templateById(maps[kind][key]);
}
