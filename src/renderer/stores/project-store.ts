/**
 * @file stores/project-store.ts
 * @purpose Projection store for the open project: scan result, raw tree,
 *   selected doc + content. Pure "reflect the world" side (CQRS): state
 *   arrives from project.open's commit, from fs-interrupt-driven rescans
 *   and from read queries. Nothing here mutates the world.
 */
import { useSyncExternalStore } from 'react';
import type {
  DocContent,
  DocType,
  FsIrisChangedEvent,
  IrisScanResult,
  RawTreeNode,
} from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { editorStore } from './editor-store';

export type ProjectPhase = 'idle' | 'opening' | 'ready' | 'error';

/** What the middle pane shows: a single doc, or a type-level collection
 *  (issue panel etc.), optionally scoped to one workspace. */
export type MiddleView =
  | { kind: 'doc' }
  | { kind: 'collection'; type: DocType; workspacePath: string | null };

export interface ProjectState {
  phase: ProjectPhase;
  /** Human-readable open failure (lastRoot vanished, not a directory…). */
  error: string | null;
  scan: IrisScanResult | null;
  rawMode: boolean;
  rawTree: RawTreeNode | null;
  selectedPath: string | null;
  docLoading: boolean;
  docError: string | null;
  view: MiddleView;
}

let state: ProjectState = {
  phase: 'idle',
  error: null,
  scan: null,
  rawMode: false,
  rawTree: null,
  selectedPath: null,
  docLoading: false,
  docError: null,
  view: { kind: 'doc' },
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
    editorStore.closeSession();
    setState({
      phase: 'ready',
      error: null,
      scan,
      rawTree: null,
      selectedPath: null,
      docError: null,
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

    // Editor-side reaction to changes of the open doc (echo dedup, live
    // reload, conflict flag, unlink) is handled by editorStore via the ISR
    // in cpu/interrupts.ts — not here. But if the selected doc vanished,
    // clear the selection.
    const sel = state.selectedPath;
    if (sel && event.changes.some((c) => c.kind === 'unlink' && c.path === sel)) {
      setState({ selectedPath: null });
    }
  },

  /** Open a type-level collection view (issue panel etc.). */
  openCollection(type: DocType, workspacePath: string | null): void {
    setState({ view: { kind: 'collection', type, workspacePath } });
  },

  /** Explicit re-projection (used by init/workspace commits). */
  async rescan(): Promise<void> {
    if (state.phase !== 'ready') return;
    try {
      const scan = await window.api.invoke<undefined, IrisScanResult>(CHANNELS.PROJECT_SCAN);
      setState({ scan });
      if (state.rawMode) await this.refreshRawTree();
    } catch (err) {
      console.warn('[project-store] rescan failed', err);
    }
  },

  /** Select a doc: flush the previous editing session, open a new one. */
  async selectDoc(path: string): Promise<void> {
    await editorStore.flushBeforeSwitch();
    setState({ selectedPath: path, docLoading: true, docError: null, view: { kind: 'doc' } });
    try {
      const content = await window.api.invoke<{ path: string }, DocContent>(CHANNELS.DOC_READ, {
        path,
      });
      // Ignore stale responses after a quick re-selection.
      if (state.selectedPath === path) {
        editorStore.openSession(content);
        setState({ docLoading: false });
      }
    } catch (err) {
      if (state.selectedPath === path) {
        editorStore.closeSession();
        setState({
          docLoading: false,
          docError: err instanceof Error ? err.message : String(err),
        });
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
