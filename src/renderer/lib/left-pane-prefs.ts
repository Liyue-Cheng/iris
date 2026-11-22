/**
 * Machine-local, per-project left-pane preferences.
 *
 * Expansion maps contain overrides only. Missing entries fall back to the
 * UI defaults, which lets newly discovered workspaces/directories appear
 * correctly without a migration. The file-tree map is bounded because large
 * repositories can otherwise grow localStorage indefinitely.
 */
import { useSyncExternalStore } from 'react';
import type { DocType, IrisWorkspace, RawTreeNode } from '@shared/types';

export type LeftPaneMode = 'documents' | 'files' | 'git';

export interface LeftPaneProjectPrefs {
  mode?: LeftPaneMode;
  workspaces: Readonly<Record<string, boolean>>;
  types: Readonly<Record<string, boolean>>;
  directories: Readonly<Record<string, boolean>>;
}

interface StoredProjectPrefs {
  mode?: LeftPaneMode;
  workspaces?: Record<string, boolean>;
  types?: Record<string, boolean>;
  directories?: Record<string, boolean>;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'iris.left-pane-prefs.v1';
const MAX_DIRECTORY_OVERRIDES = 500;
const EMPTY_PROJECT_PREFS: LeftPaneProjectPrefs = Object.freeze({
  workspaces: Object.freeze({}),
  types: Object.freeze({}),
  directories: Object.freeze({}),
});

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function isMode(value: unknown): value is LeftPaneMode {
  return value === 'documents' || value === 'files' || value === 'git';
}

function booleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
  );
}

function load(storage: StorageLike | undefined): Record<string, StoredProjectPrefs> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([projectRoot, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const candidate = value as Record<string, unknown>;
        return [[projectRoot, {
          ...(isMode(candidate.mode) ? { mode: candidate.mode } : {}),
          workspaces: booleanRecord(candidate.workspaces),
          types: booleanRecord(candidate.types),
          directories: booleanRecord(candidate.directories),
        } satisfies StoredProjectPrefs]];
      }),
    );
  } catch {
    return {};
  }
}

export function leftPaneTypeKey(workspacePath: string, type: DocType): string {
  return `${workspacePath}\u0000${type}`;
}

function hasStoredValues(prefs: StoredProjectPrefs): boolean {
  return prefs.mode !== undefined ||
    Object.keys(prefs.workspaces ?? {}).length > 0 ||
    Object.keys(prefs.types ?? {}).length > 0 ||
    Object.keys(prefs.directories ?? {}).length > 0;
}

function pruneRecord(
  record: Readonly<Record<string, boolean>>,
  validKeys: ReadonlySet<string>,
): Record<string, boolean> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => validKeys.has(key)));
}

export class LeftPanePrefsStore {
  private projects: Record<string, StoredProjectPrefs>;
  private readonly subscribers = new Set<() => void>();

  constructor(private readonly storage: StorageLike | undefined = browserStorage()) {
    this.projects = load(storage);
  }

  subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  };

  reload(): void {
    this.projects = load(this.storage);
    this.emit();
  }

  getProject(projectRoot: string | null): LeftPaneProjectPrefs {
    if (!projectRoot) return EMPTY_PROJECT_PREFS;
    const prefs = this.projects[projectRoot];
    if (!prefs) return EMPTY_PROJECT_PREFS;
    return prefs as LeftPaneProjectPrefs;
  }

  getMode(projectRoot: string | null): LeftPaneMode {
    return this.getProject(projectRoot).mode ?? 'documents';
  }

  workspaceOpen(projectRoot: string, workspacePath: string, isRoot: boolean): boolean {
    return this.getProject(projectRoot).workspaces[workspacePath] ?? isRoot;
  }

  typeOpen(projectRoot: string, workspacePath: string, type: DocType): boolean {
    return this.getProject(projectRoot).types[leftPaneTypeKey(workspacePath, type)] ?? true;
  }

  directoryOpen(projectRoot: string, path: string, isRoot: boolean): boolean {
    return this.getProject(projectRoot).directories[path] ?? isRoot;
  }

  setMode(projectRoot: string, mode: LeftPaneMode): void {
    const current = this.projects[projectRoot] ?? {};
    const { mode: _currentMode, ...withoutMode } = current;
    this.replace(projectRoot, mode === 'documents' ? withoutMode : { ...withoutMode, mode });
  }

  setWorkspaceOpen(
    projectRoot: string,
    workspacePath: string,
    isRoot: boolean,
    open: boolean,
  ): void {
    const current = this.projects[projectRoot] ?? {};
    const workspaces = { ...(current.workspaces ?? {}) };
    if (open === isRoot) delete workspaces[workspacePath];
    else workspaces[workspacePath] = open;
    this.replace(projectRoot, { ...current, workspaces });
  }

  setTypeOpen(projectRoot: string, workspacePath: string, type: DocType, open: boolean): void {
    const current = this.projects[projectRoot] ?? {};
    const types = { ...(current.types ?? {}) };
    const key = leftPaneTypeKey(workspacePath, type);
    if (open) delete types[key];
    else types[key] = false;
    this.replace(projectRoot, { ...current, types });
  }

  setDirectoryOpen(projectRoot: string, path: string, isRoot: boolean, open: boolean): void {
    const current = this.projects[projectRoot] ?? {};
    const directories = { ...(current.directories ?? {}) };
    if (open === isRoot) delete directories[path];
    else {
      delete directories[path];
      directories[path] = open;
    }
    const keys = Object.keys(directories);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_DIRECTORY_OVERRIDES))) {
      delete directories[key];
    }
    this.replace(projectRoot, { ...current, directories });
  }

  revealDocument(projectRoot: string, workspacePath: string, type: DocType): void {
    const current = this.projects[projectRoot] ?? {};
    const workspaces = { ...(current.workspaces ?? {}) };
    const types = { ...(current.types ?? {}) };
    if (workspacePath === '.iris') delete workspaces[workspacePath];
    else workspaces[workspacePath] = true;
    delete types[leftPaneTypeKey(workspacePath, type)];
    this.replace(projectRoot, { ...current, workspaces, types });
  }

  reconcileLens(
    projectRoot: string,
    workspacePaths: ReadonlySet<string>,
    typeKeys: ReadonlySet<string>,
  ): void {
    const current = this.projects[projectRoot];
    if (!current) return;
    this.replace(projectRoot, {
      ...current,
      workspaces: pruneRecord(current.workspaces ?? {}, workspacePaths),
      types: pruneRecord(current.types ?? {}, typeKeys),
    });
  }

  reconcileDirectories(projectRoot: string, directoryPaths: ReadonlySet<string>): void {
    const current = this.projects[projectRoot];
    if (!current) return;
    this.replace(projectRoot, {
      ...current,
      directories: pruneRecord(current.directories ?? {}, directoryPaths),
    });
  }

  private replace(projectRoot: string, prefs: StoredProjectPrefs): void {
    const normalized: StoredProjectPrefs = {
      ...(prefs.mode ? { mode: prefs.mode } : {}),
      workspaces: prefs.workspaces ?? {},
      types: prefs.types ?? {},
      directories: prefs.directories ?? {},
    };
    const next = { ...this.projects };
    if (hasStoredValues(normalized)) next[projectRoot] = normalized;
    else delete next[projectRoot];
    const previousJson = JSON.stringify(this.projects);
    const nextJson = JSON.stringify(next);
    if (previousJson === nextJson) return;
    this.projects = next;
    try {
      this.storage?.setItem(STORAGE_KEY, nextJson);
    } catch {
      // Persistence is best-effort; the in-memory session state still works.
    }
    this.emit();
  }

  private emit(): void {
    this.subscribers.forEach((callback) => callback());
  }
}

export const leftPanePrefs = new LeftPanePrefsStore();

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) leftPanePrefs.reload();
  });
}

export function useLeftPanePrefs(projectRoot: string | null): LeftPaneProjectPrefs {
  return useSyncExternalStore(
    leftPanePrefs.subscribe,
    () => leftPanePrefs.getProject(projectRoot),
  );
}

const DOC_TYPES: DocType[] = ['status', 'issue', 'report', 'misc'];

export function reconcileLensPrefs(projectRoot: string, root: IrisWorkspace | null): void {
  const workspaces = new Set<string>();
  const types = new Set<string>();
  const visit = (workspace: IrisWorkspace): void => {
    workspaces.add(workspace.path);
    DOC_TYPES.forEach((type) => types.add(leftPaneTypeKey(workspace.path, type)));
    workspace.children.forEach(visit);
  };
  if (root) visit(root);
  leftPanePrefs.reconcileLens(projectRoot, workspaces, types);
}

export function reconcileDirectoryPrefs(projectRoot: string, root: RawTreeNode | null): void {
  const directories = new Set<string>();
  const visit = (node: RawTreeNode): void => {
    if (node.kind !== 'dir') return;
    directories.add(node.path);
    node.children?.forEach(visit);
  };
  if (root) visit(root);
  leftPanePrefs.reconcileDirectories(projectRoot, directories);
}
