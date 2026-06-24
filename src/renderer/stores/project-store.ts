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
import { focusStore, type FocusTarget } from './focus-store';
import { getSettings } from './settings-store';

export type ProjectPhase = 'idle' | 'opening' | 'ready' | 'error';

/** What the middle pane shows: a single doc, a type-level collection
 *  (issue panel etc.), the cross-issue todo panel, the project-root hub
 *  (the special root node, E-4), or a sub-workspace hub — both hubs give
 *  the terminal the full width. Collections are optionally scoped to one
 *  workspace. */
export type MiddleView =
  | { kind: 'doc' }
  | { kind: 'collection'; type: DocType; workspacePath: string | null }
  | { kind: 'todos'; workspacePath: string | null }
  | { kind: 'root' }
  | { kind: 'workspace'; path: string };

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

/** Where keyboard focus should land when this doc is selected (P1/P5),
 *  honoring behavior.focusOnSelectDoc. Read AFTER sessionStore.syncToDoc so
 *  the staged session reflects this anchor. `forceEditor` (new-doc create)
 *  overrides the setting. */
/** Persist the current editor's pending edits without blocking a view switch
 *  (P3). save() composes the current session's bytes synchronously before its
 *  first await, so calling this immediately before replacing the session
 *  captures the OLD doc; its post-write re-baseline is path-guarded and won't
 *  touch the new session. A clean session makes save() a no-op. */
function flushInBackground(): void {
  void editorStore.flushBeforeSwitch();
}

function focusTargetForDoc(path: string, forceEditor: boolean): FocusTarget {
  if (forceEditor) return 'editor';
  const pref = getSettings()?.behavior.focusOnSelectDoc ?? 'editor';
  if (pref === 'editor') return 'editor';
  const { activeSessionId, sessions } = sessionStore.get();
  const staged = sessions.find((s) => s.id === activeSessionId && s.docPath === path);
  if (!staged) return 'editor'; // no terminal to focus → fall back to the body
  if (pref === 'terminal') return 'terminal';
  return staged.state === 'active' ? 'terminal' : 'editor'; // 'auto'
}

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
  openCollection(type: DocType, workspacePath: string | null): void {
    flushInBackground();
    setState({ view: { kind: 'collection', type, workspacePath } });
    focusStore.request('panel');
  },

  /** Open the todo panel (unchecked tasks across active issues). */
  openTodos(workspacePath: string | null): void {
    flushInBackground();
    setState({ view: { kind: 'todos', workspacePath } });
    focusStore.request('panel');
  },

  /** The special root node (E-4): middle shows the project README (or a
   *  placeholder), right shows the project-root sessions (terminal-only view,
   *  so focus goes to the terminal). */
  selectRoot(): void {
    flushInBackground();
    editorStore.closeSession();
    setState({ selectedPath: null, view: { kind: 'root' }, docError: null });
    sessionStore.syncToRoot();
    focusStore.request('terminal');
  },

  /** A sub-workspace hub (terminal parity with the root node): like
   *  selectRoot, the middle pane yields to a full-width terminal and the
   *  right pane stages this workspace's hub sessions. */
  selectWorkspace(path: string): void {
    flushInBackground();
    editorStore.closeSession();
    setState({ selectedPath: null, view: { kind: 'workspace', path }, docError: null });
    sessionStore.syncToWorkspace(path);
    focusStore.request('terminal');
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
   *  `focusEditor` forces input focus into the editor regardless of the
   *  focusOnSelectDoc setting (new-doc create always wants the body). */
  async selectDoc(path: string, opts?: { focusEditor?: boolean }): Promise<void> {
    // Re-selecting the doc already shown in the doc view is a no-op: re-reading
    // would flash the loading spinner and remount Crepe (generation bump) for
    // zero information — that's the "repeated click flicker". A prior read
    // error still allows a retry.
    if (state.view.kind === 'doc' && state.selectedPath === path && state.docError === null) {
      return;
    }
    // P3: don't block the switch on a disk round-trip. The previous doc's
    // pending edits flush in the background — doc.save is serial per doc:path
    // and the editor's echo-dedup (disk === lastWritten) absorbs our own write,
    // so the UI/focus swap happens at once instead of after the save IPC.
    flushInBackground();
    setState({ selectedPath: path, docLoading: true, docError: null, view: { kind: 'doc' } });
    sessionStore.syncToDoc(path);
    // Declare the focus target now (P1/P5): the editor/terminal claims it once
    // ready, so timing relative to the async read below doesn't matter.
    focusStore.request(focusTargetForDoc(path, opts?.focusEditor ?? false));
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
