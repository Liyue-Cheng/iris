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
import { sessionStore } from './session-store';
import { stylesStore } from './styles-store';

export type ProjectPhase = 'idle' | 'opening' | 'ready' | 'error';

/** What the middle pane shows: a single doc, a type-level collection
 *  (issue panel etc.), the cross-issue todo panel, or the project-root
 *  README (the special root node, E-4) — collections are optionally
 *  scoped to one workspace. */
export type MiddleView =
  | { kind: 'doc' }
  | { kind: 'collection'; type: DocType; workspacePath: string | null }
  | { kind: 'todos'; workspacePath: string | null }
  | { kind: 'root' };

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
    void stylesStore.refresh();
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
  async openCollection(type: DocType, workspacePath: string | null): Promise<void> {
    await editorStore.flushBeforeSwitch();
    setState({ view: { kind: 'collection', type, workspacePath } });
  },

  /** Open the todo panel (unchecked tasks across active issues). */
  async openTodos(workspacePath: string | null): Promise<void> {
    await editorStore.flushBeforeSwitch();
    setState({ view: { kind: 'todos', workspacePath } });
  },

  /** The special root node (E-4): middle shows the project README (or a
   *  placeholder), right shows the project-root sessions. */
  async selectRoot(): Promise<void> {
    await editorStore.flushBeforeSwitch();
    editorStore.closeSession();
    setState({ selectedPath: null, view: { kind: 'root' }, docError: null });
    sessionStore.syncToRoot();
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

  /** Select a doc: flush the previous editing session, open a new one.
   *  Also re-stages the right pane onto this doc's best session (or the
   *  launcher panel when it has none) — pure projection-level linkage.
   *  `focusEditor` grabs input focus on the fresh mount (new-doc create). */
  async selectDoc(path: string, opts?: { focusEditor?: boolean }): Promise<void> {
    // Re-selecting the doc already shown in the doc view is a no-op: re-reading
    // would flash the loading spinner and remount Crepe (generation bump) for
    // zero information — that's the "repeated click flicker". A prior read
    // error still allows a retry.
    if (state.view.kind === 'doc' && state.selectedPath === path && state.docError === null) {
      return;
    }
    await editorStore.flushBeforeSwitch();
    setState({ selectedPath: path, docLoading: true, docError: null, view: { kind: 'doc' } });
    sessionStore.syncToDoc(path);
    try {
      const content = await window.api.invoke<{ path: string }, DocContent>(CHANNELS.DOC_READ, {
        path,
      });
      // Ignore stale responses after a quick re-selection.
      if (state.selectedPath === path) {
        editorStore.openSession(content, opts?.focusEditor ? { focus: true } : undefined);
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
