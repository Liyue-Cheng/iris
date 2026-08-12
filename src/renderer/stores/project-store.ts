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
  IrisWorkspace,
  ProjectOpenResult,
  ProjectScope,
  RawTreeNode,
  SessionInfo,
} from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { editorStore } from './editor-store';
import { sessionAnchorKey, sessionStore, workspaceAnchorKey } from './session-store';
import { projectScopeState, sameProjectScope } from './project-scope-state';
import { healthStore } from './health-store';
import { findDocByPath } from '@renderer/lib/doc-utils';

export type ProjectPhase = 'idle' | 'opening' | 'ready' | 'error';

/** What the middle pane shows: a single doc, a type-level collection
 *  (issue panel etc.), the cross-issue todo panel, the project-root hub
 *  (the special root node, E-4), or a sub-workspace hub — both hubs give
 *  the terminal the full width. Collections are optionally scoped to one
 *  workspace. */
export type MainView =
  | { kind: 'doc'; path: string | null }
  | { kind: 'todos'; workspacePath: string | null }
  | { kind: 'root' }
  | { kind: 'workspace'; path: string };

export type CollectionView = {
  kind: 'collection';
  type: DocType;
  workspacePath: string | null;
  selectedPath: string | null;
  returnTo: MainView;
  returnWorkspacePath: string | null;
};

export type MiddleView = MainView | CollectionView;

export interface ProjectState {
  phase: ProjectPhase;
  /** Human-readable open failure (lastRoot vanished, not a directory…). */
  error: string | null;
  scope: ProjectScope | null;
  scan: IrisScanResult | null;
  rawMode: boolean;
  rawTree: RawTreeNode | null;
  docLoading: boolean;
  docError: string | null;
  view: MiddleView;
}

let state: ProjectState = {
  phase: 'idle',
  error: null,
  scope: null,
  scan: null,
  rawMode: false,
  rawTree: null,
  docLoading: false,
  docError: null,
  view: { kind: 'doc', path: null },
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
let navigationIntent = 0;
const collectionSelectionByScope = new Map<string, string>();

function collectionScopeKey(type: DocType, workspacePath: string | null): string {
  return `${state.scope?.root ?? ''}\u0000${type}\u0000${workspacePath ?? ''}`;
}

function workspaceExists(root: IrisWorkspace, path: string): boolean {
  if (root.path === path) return true;
  return root.children.some((child) => workspaceExists(child, path));
}

async function refreshScanProjection(scope: ProjectScope): Promise<void> {
  const scan = await window.api.invoke<
    { expectedScope: ProjectScope },
    IrisScanResult
  >(CHANNELS.PROJECT_SCAN, { expectedScope: scope });
  if (!sameProjectScope(scope, projectScopeState.get())) return;
  setState({ scan });
  healthStore.resolve('project-projection', scope);
}

async function refreshRawProjection(scope: ProjectScope): Promise<void> {
  const rawTree = await window.api.invoke<
    { expectedScope: ProjectScope },
    RawTreeNode | null
  >(CHANNELS.PROJECT_RAW_TREE, { expectedScope: scope });
  if (!sameProjectScope(scope, projectScopeState.get())) return;
  setState({ rawTree });
  healthStore.resolve('project-raw-tree', scope);
}

/** A view change may discard the only mounted draft, so it waits for the
 * unified save decision. Conflict-policy "ask" and write failures keep the
 * current view in place. */
async function canLeaveEditor(): Promise<boolean> {
  return editorStore.flushBeforeSwitch('view-switch');
}

function beginNavigationIntent(): number {
  navigationIntent += 1;
  return navigationIntent;
}

function isCurrentIntent(intent: number): boolean {
  return intent === navigationIntent;
}

async function mayCommitNavigation(intent: number): Promise<boolean> {
  return (await canLeaveEditor()) && isCurrentIntent(intent);
}

function currentAnchorKey(): string | null {
  if (state.view.kind === 'doc') return state.view.path;
  if (state.view.kind === 'root') return workspaceAnchorKey('.iris');
  if (state.view.kind === 'workspace') return workspaceAnchorKey(state.view.path);
  return null;
}

function sessionStillMatches(sessionId: string, anchorKey: string): SessionInfo | null {
  const scope = state.scope;
  const session = sessionStore.get().sessions.find((candidate) => candidate.id === sessionId);
  if (
    !scope ||
    !session ||
    session.projectRoot !== scope.root ||
    session.projectGeneration !== scope.generation ||
    sessionAnchorKey(session) !== anchorKey
  ) {
    return null;
  }
  return session;
}

function selectPreparedSession(sessionId: string | undefined, anchorKey: string): boolean {
  if (!sessionId) return true;
  return sessionStillMatches(sessionId, anchorKey) !== null && sessionStore.select(sessionId);
}

async function navigateToHub(
  intent: number,
  workspacePath: string,
  sessionId?: string,
): Promise<boolean> {
  const anchorKey = workspaceAnchorKey(workspacePath);
  if (currentAnchorKey() === anchorKey) {
    return isCurrentIntent(intent) && selectPreparedSession(sessionId, anchorKey);
  }
  if (!(await mayCommitNavigation(intent))) return false;
  if (!selectPreparedSession(sessionId, anchorKey)) return false;

  editorStore.closeSession();
  setState({
    docLoading: false,
    docError: null,
    view:
      workspacePath === '.iris'
        ? { kind: 'root' }
        : { kind: 'workspace', path: workspacePath },
  });
  return true;
}

async function commitDocNavigation(
  intent: number,
  path: string,
  sessionId?: string,
): Promise<boolean> {
  if (!selectPreparedSession(sessionId, path)) return false;

  const scope = state.scope;
  if (!scope) return false;
  setState({ docLoading: true, docError: null, view: { kind: 'doc', path } });
  try {
    const content = await window.api.invoke<
      { path: string; expectedScope: ProjectScope },
      DocContent
    >(CHANNELS.DOC_READ, { path, expectedScope: scope });
    if (
      !isCurrentIntent(intent) ||
      state.view.kind !== 'doc' ||
      state.view.path !== path ||
      !sameProjectScope(scope, state.scope)
    ) {
      return false;
    }
    editorStore.openSession(content);
    setState({ docLoading: false });
    return true;
  } catch (err) {
    if (
      isCurrentIntent(intent) &&
      state.view.kind === 'doc' &&
      state.view.path === path &&
      sameProjectScope(scope, state.scope)
    ) {
      editorStore.closeSession();
      setState({
        docLoading: false,
        docError: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }
}

async function navigateToDoc(
  intent: number,
  path: string,
  sessionId?: string,
): Promise<boolean> {
  if (state.view.kind === 'doc' && state.view.path === path && state.docError === null) {
    return isCurrentIntent(intent) && selectPreparedSession(sessionId, path);
  }
  if (!(await mayCommitNavigation(intent))) return false;
  return commitDocNavigation(intent, path, sessionId);
}

async function loadCollectionDoc(intent: number, path: string): Promise<boolean> {
  const scope = state.scope;
  if (!scope) return false;
  try {
    const content = await window.api.invoke<
      { path: string; expectedScope: ProjectScope },
      DocContent
    >(CHANNELS.DOC_READ, { path, expectedScope: scope });
    if (
      !isCurrentIntent(intent) ||
      state.view.kind !== 'collection' ||
      state.view.selectedPath !== path ||
      !sameProjectScope(scope, state.scope)
    ) {
      return false;
    }
    editorStore.openSession(content);
    setState({ docLoading: false });
    return true;
  } catch (err) {
    if (
      isCurrentIntent(intent) &&
      state.view.kind === 'collection' &&
      state.view.selectedPath === path &&
      sameProjectScope(scope, state.scope)
    ) {
      editorStore.closeSession();
      setState({
        docLoading: false,
        docError: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
  }
}

async function navigateToCollectionDoc(intent: number, path: string): Promise<boolean> {
  if (
    state.view.kind === 'collection' &&
    state.view.selectedPath === path &&
    state.docError === null
  ) {
    return isCurrentIntent(intent);
  }
  if (!(await mayCommitNavigation(intent))) return false;
  if (state.view.kind !== 'collection') return false;
  const doc = state.scan?.root ? findDocByPath(state.scan.root, path) : null;
  if (
    !doc ||
    doc.type !== state.view.type ||
    (state.view.workspacePath !== null && doc.workspacePath !== state.view.workspacePath)
  ) {
    return false;
  }

  collectionSelectionByScope.set(
    collectionScopeKey(state.view.type, state.view.workspacePath),
    path,
  );
  editorStore.closeSession();
  setState({
    docLoading: true,
    docError: null,
    view: { ...state.view, selectedPath: path },
  });
  return loadCollectionDoc(intent, path);
}

export const projectStore = {
  get(): ProjectState {
    return state;
  },

  markOpening(): void {
    beginNavigationIntent();
    projectScopeState.setSwitching(true);
    setState({ phase: 'opening', error: null });
  },

  /** Commit hook of project.open. */
  handleOpened(result: Omit<ProjectOpenResult, 'projectSettings'>): void {
    const { scan, scope } = result;
    const idempotent = sameProjectScope(scope, state.scope);
    healthStore.resetForScope(scope);
    if (idempotent) {
      projectScopeState.set(scope);
      projectScopeState.setSwitching(false);
      setState({ phase: 'ready', error: null, scope, scan });
      return;
    }
    beginNavigationIntent();
    collectionSelectionByScope.clear();
    editorStore.closeSession();
    projectScopeState.set(scope);
    projectScopeState.setSwitching(false);
    setState({
      phase: 'ready',
      error: null,
      scope,
      scan,
      rawTree: null,
      view: { kind: 'doc', path: null },
      docLoading: false,
      docError: null,
    });
    if (state.rawMode) void this.refreshRawTree();
  },

  handleOpenFailed(message: string): void {
    projectScopeState.setSwitching(false);
    setState({ phase: state.scan ? 'ready' : 'error', error: message });
  },

  /** Renderer reload: main already owns the project, so hydrate by query
   *  instead of replaying the external project.open verb. */
  async restoreActive(scope: ProjectScope): Promise<void> {
    projectScopeState.set(scope);
    setState({ phase: 'opening', error: null, scope });
    try {
      const scan = await window.api.invoke<
        { expectedScope: ProjectScope },
        IrisScanResult
      >(CHANNELS.PROJECT_SCAN, { expectedScope: scope });
      if (!sameProjectScope(scope, projectScopeState.get())) return;
      this.handleOpened({ scope, scan, sessions: [] });
    } catch (err) {
      this.handleOpenFailed(err instanceof Error ? err.message : String(err));
    }
  },

  /** ISR entry: a batch of .iris/ changes landed — re-project. */
  async refreshFromFs(event: FsIrisChangedEvent): Promise<void> {
    if (state.phase !== 'ready') return;
    const scope = state.scope;
    if (
      !scope ||
      event.projectRoot !== scope.root ||
      event.projectGeneration !== scope.generation
    ) {
      return;
    }
    if (scanInFlight) {
      scanDirty = true;
      return;
    }
    scanInFlight = true;
    try {
      do {
        scanDirty = false;
        await refreshScanProjection(scope);
        if (state.rawMode) await this.refreshRawTree();
      } while (scanDirty);
    } catch (err) {
      console.warn('[project-store] rescan failed', err);
      healthStore.degrade({
        key: 'project-projection',
        domain: 'project-projection',
        cause: err,
        scope,
        retry: () => refreshScanProjection(scope),
      });
    } finally {
      scanInFlight = false;
    }

    // Editor-side reaction to changes of the open doc (echo dedup, live
    // reload, conflict flag, unlink) is handled by editorStore via the ISR
    // in cpu/interrupts.ts — not here. But if the selected doc vanished,
    // clear the selection.
    const unlinkedPaths = new Set(
      event.changes.filter((change) => change.kind === 'unlink').map((change) => change.path),
    );
    for (const [key, path] of collectionSelectionByScope) {
      if (unlinkedPaths.has(path)) collectionSelectionByScope.delete(key);
    }

    const selectedPath =
      state.view.kind === 'doc'
        ? state.view.path
        : state.view.kind === 'collection'
          ? state.view.selectedPath
          : null;
    if (
      selectedPath &&
      event.changes.some((change) => change.kind === 'unlink' && change.path === selectedPath)
    ) {
      beginNavigationIntent();
      editorStore.closeSession();
      if (state.view.kind === 'collection') {
        collectionSelectionByScope.delete(
          collectionScopeKey(state.view.type, state.view.workspacePath),
        );
        setState({
          view: { ...state.view, selectedPath: null },
          docLoading: false,
          docError: null,
        });
      } else {
        setState({ view: { kind: 'doc', path: null }, docLoading: false, docError: null });
      }
    }
  },

  /** Open a type-level collection view (issue panel etc.). */
  async openCollection(type: DocType, workspacePath: string | null): Promise<boolean> {
    if (
      state.view.kind === 'collection' &&
      state.view.type === type &&
      state.view.workspacePath === workspacePath
    ) {
      return true;
    }
    const intent = beginNavigationIntent();
    if (!(await mayCommitNavigation(intent))) return false;

    const returnTo = state.view.kind === 'collection' ? state.view.returnTo : state.view;
    const returnWorkspacePath =
      state.view.kind === 'collection'
        ? state.view.returnWorkspacePath
        : state.view.kind === 'doc' && state.view.path && state.scan?.root
          ? findDocByPath(state.scan.root, state.view.path)?.workspacePath ?? null
          : null;
    const rememberedPath =
      collectionSelectionByScope.get(collectionScopeKey(type, workspacePath)) ?? null;
    const rememberedDoc =
      rememberedPath && state.scan?.root ? findDocByPath(state.scan.root, rememberedPath) : null;
    const selectedPath =
      rememberedDoc?.type === type &&
      (workspacePath === null || rememberedDoc.workspacePath === workspacePath)
        ? rememberedPath
        : null;
    if (rememberedPath && !selectedPath) {
      collectionSelectionByScope.delete(collectionScopeKey(type, workspacePath));
    }
    const reuseSession = selectedPath !== null && editorStore.get()?.path === selectedPath;
    if (reuseSession) editorStore.prepareForRemount();
    else editorStore.closeSession();
    setState({
      view: {
        kind: 'collection',
        type,
        workspacePath,
        selectedPath,
        returnTo,
        returnWorkspacePath,
      },
      docLoading: selectedPath !== null && !reuseSession,
      docError: null,
    });
    if (selectedPath !== null && !reuseSession) {
      return loadCollectionDoc(intent, selectedPath);
    }
    return true;
  },

  /** Select a document for the collection's right-hand detail pane. */
  async selectCollectionDoc(path: string): Promise<boolean> {
    return navigateToCollectionDoc(beginNavigationIntent(), path);
  },

  /** Move a collection document into the normal editor + terminal shell. */
  async openCollectionDocInDefaultView(path?: string): Promise<boolean> {
    if (state.view.kind !== 'collection') return false;
    const targetPath = path ?? state.view.selectedPath;
    if (!targetPath) return false;
    if (
      state.view.selectedPath !== targetPath ||
      editorStore.get()?.path !== targetPath
    ) {
      if (!(await navigateToCollectionDoc(beginNavigationIntent(), targetPath))) return false;
    }
    if (
      state.view.kind !== 'collection' ||
      !state.view.selectedPath ||
      editorStore.get()?.path !== state.view.selectedPath
    ) {
      return false;
    }
    beginNavigationIntent();
    const selectedPath = state.view.selectedPath;
    editorStore.prepareForRemount();
    setState({ view: { kind: 'doc', path: selectedPath }, docLoading: false, docError: null });
    return true;
  },

  /** Leave a document collection and restore the exact main-page view that opened it. */
  async leaveCollection(): Promise<boolean> {
    if (state.view.kind !== 'collection') return false;
    const intent = beginNavigationIntent();
    if (!(await mayCommitNavigation(intent))) return false;
    if (state.view.kind !== 'collection') return false;

    const { returnTo, returnWorkspacePath } = state.view;
    if (returnTo.kind === 'doc' && returnTo.path) {
      const sourceStillExists = state.scan?.root
        ? findDocByPath(state.scan.root, returnTo.path) !== null
        : true;
      if (sourceStillExists) return commitDocNavigation(intent, returnTo.path);
    }

    editorStore.closeSession();
    if (returnTo.kind === 'doc') {
      const fallback = returnWorkspacePath ?? '.iris';
      const fallbackExists = state.scan?.root
        ? workspaceExists(state.scan.root, fallback)
        : fallback === '.iris';
      setState({
        view:
          fallback === '.iris' || !fallbackExists
            ? { kind: 'root' }
            : { kind: 'workspace', path: fallback },
        docLoading: false,
        docError: null,
      });
      return true;
    }
    if (
      returnTo.kind === 'workspace' &&
      state.scan?.root &&
      !workspaceExists(state.scan.root, returnTo.path)
    ) {
      setState({ view: { kind: 'root' }, docLoading: false, docError: null });
      return true;
    }
    if (
      returnTo.kind === 'todos' &&
      returnTo.workspacePath &&
      state.scan?.root &&
      !workspaceExists(state.scan.root, returnTo.workspacePath)
    ) {
      setState({ view: { kind: 'root' }, docLoading: false, docError: null });
      return true;
    }
    setState({ view: returnTo, docLoading: false, docError: null });
    return true;
  },

  /** Open the todo panel (unchecked tasks across active issues). */
  async openTodos(workspacePath: string | null): Promise<boolean> {
    const intent = beginNavigationIntent();
    if (!(await mayCommitNavigation(intent))) return false;
    setState({ view: { kind: 'todos', workspacePath } });
    return true;
  },

  /** The special root node (E-4): middle shows the project README (or a
   *  placeholder), right shows the project-root sessions (terminal-only view,
   *  so focus goes to the terminal). */
  async selectRoot(): Promise<boolean> {
    return navigateToHub(beginNavigationIntent(), '.iris');
  },

  /** A sub-workspace hub (terminal parity with the root node): like
   *  selectRoot, the middle pane yields to a full-width terminal and the
   *  right pane stages this workspace's hub sessions. */
  async selectWorkspace(path: string): Promise<boolean> {
    return navigateToHub(beginNavigationIntent(), path);
  },

  /** One user intent: navigate to a session's anchor and select it there. */
  async activateSession(sessionId: string): Promise<boolean> {
    const session = sessionStore.get().sessions.find((candidate) => candidate.id === sessionId);
    const scope = state.scope;
    if (
      !session ||
      !scope ||
      session.projectRoot !== scope.root ||
      session.projectGeneration !== scope.generation
    ) {
      return false;
    }

    const intent = beginNavigationIntent();
    if (session.docPath !== null) {
      return navigateToDoc(intent, session.docPath, sessionId);
    }
    return navigateToHub(intent, session.workspacePath ?? '.iris', sessionId);
  },

  /** Explicit re-projection (used by init/workspace commits). */
  async rescan(): Promise<void> {
    if (state.phase !== 'ready') return;
    const scope = state.scope;
    if (!scope) return;
    try {
      await refreshScanProjection(scope);
      if (state.rawMode) await this.refreshRawTree();
    } catch (err) {
      console.warn('[project-store] rescan failed', err);
      healthStore.degrade({
        key: 'project-projection',
        domain: 'project-projection',
        cause: err,
        scope,
        retry: () => refreshScanProjection(scope),
      });
    }
  },

  /** Select a document without altering that document's remembered terminal. */
  async selectDoc(path: string): Promise<boolean> {
    return navigateToDoc(beginNavigationIntent(), path);
  },

  async toggleRawMode(): Promise<void> {
    const next = !state.rawMode;
    setState({ rawMode: next });
    if (next && state.phase === 'ready') {
      await this.refreshRawTree();
    }
  },

  async refreshRawTree(): Promise<void> {
    const scope = state.scope;
    if (!scope) return;
    try {
      await refreshRawProjection(scope);
    } catch (err) {
      console.warn('[project-store] raw tree failed', err);
      healthStore.degrade({
        key: 'project-raw-tree',
        domain: 'project-projection',
        cause: err,
        scope,
        retry: () => refreshRawProjection(scope),
      });
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
