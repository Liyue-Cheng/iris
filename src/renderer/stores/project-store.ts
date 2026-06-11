/**
 * @file stores/project-store.ts
 * @purpose Projection store for the open project: scan result, raw tree,
 *   selected doc + content. Pure "reflect the world" side (CQRS): state
 *   arrives from project.open's commit, from fs-interrupt-driven rescans
 *   and from read queries. Nothing here mutates the world.
 */
import { useSyncExternalStore } from 'react';
import type { DocContent, FsIrisChangedEvent, IrisScanResult, RawTreeNode } from '@shared/types';
import { CHANNELS } from '@shared/protocol';

export type ProjectPhase = 'idle' | 'opening' | 'ready' | 'error';

export interface ProjectState {
  phase: ProjectPhase;
  /** Human-readable open failure (lastRoot vanished, not a directory…). */
  error: string | null;
  scan: IrisScanResult | null;
  rawMode: boolean;
  rawTree: RawTreeNode | null;
  selectedPath: string | null;
  docContent: DocContent | null;
  docLoading: boolean;
}

let state: ProjectState = {
  phase: 'idle',
  error: null,
  scan: null,
  rawMode: false,
  rawTree: null,
  selectedPath: null,
  docContent: null,
  docLoading: false,
};

const subscribers = new Set<() => void>();

function setState(patch: Partial<ProjectState>): void {
  state = { ...state, ...patch };
  subscribers.forEach((cb) => cb());
}

// Coalescing guard: fs events during an in-flight rescan mark it dirty and
// trigger exactly one follow-up scan (no unbounded pile-up).
let scanInFlight = false;
let scanDirty = false;

export const projectStore = {
  get(): ProjectState {
    return state;
  },

  markOpening(): void {
    setState({ phase: 'opening', error: null });
  },

  /** Commit hook of project.open. */
  handleOpened(scan: IrisScanResult): void {
    setState({
      phase: 'ready',
      error: null,
      scan,
      rawTree: null,
      selectedPath: null,
      docContent: null,
    });
    if (state.rawMode) void this.refreshRawTree();
  },

  handleOpenFailed(message: string): void {
    setState({ phase: 'error', error: message });
  },

  /** ISR entry: a batch of .iris/ changes landed — re-project. */
  async refreshFromFs(event: FsIrisChangedEvent): Promise<void> {
    if (state.phase !== 'ready') return;
    if (scanInFlight) {
      scanDirty = true;
      return;
    }
    scanInFlight = true;
    try {
      do {
        scanDirty = false;
        const scan = await window.api.invoke<undefined, IrisScanResult>(CHANNELS.PROJECT_SCAN);
        setState({ scan });
        if (state.rawMode) await this.refreshRawTree();
      } while (scanDirty);
    } catch (err) {
      console.warn('[project-store] rescan failed', err);
    } finally {
      scanInFlight = false;
    }

    // If the doc being previewed changed on disk, re-read it so the middle
    // pane follows external edits live.
    const sel = state.selectedPath;
    if (sel && event.changes.some((c) => c.path === sel)) {
      const stillExists = !event.changes.some((c) => c.kind === 'unlink' && c.path === sel);
      if (stillExists) {
        await this.selectDoc(sel);
      } else {
        setState({ selectedPath: null, docContent: null });
      }
    }
  },

  async selectDoc(path: string): Promise<void> {
    setState({ selectedPath: path, docLoading: true });
    try {
      const content = await window.api.invoke<{ path: string }, DocContent>(CHANNELS.DOC_READ, {
        path,
      });
      // Ignore stale responses after a quick re-selection.
      if (state.selectedPath === path) {
        setState({ docContent: content, docLoading: false });
      }
    } catch (err) {
      if (state.selectedPath === path) {
        setState({ docContent: null, docLoading: false });
        console.warn('[project-store] doc read failed', err);
      }
    }
  },

  async toggleRawMode(): Promise<void> {
    const next = !state.rawMode;
    setState({ rawMode: next });
    if (next && state.phase === 'ready') {
      await this.refreshRawTree();
    }
  },

  async refreshRawTree(): Promise<void> {
    try {
      const rawTree = await window.api.invoke<undefined, RawTreeNode | null>(
        CHANNELS.PROJECT_RAW_TREE,
      );
      setState({ rawTree });
    } catch (err) {
      console.warn('[project-store] raw tree failed', err);
    }
  },
};

export function useProject(): ProjectState {
  return useSyncExternalStore(
    (onStoreChange) => {
      subscribers.add(onStoreChange);
      return () => {
        subscribers.delete(onStoreChange);
      };
    },
    () => state,
  );
}
