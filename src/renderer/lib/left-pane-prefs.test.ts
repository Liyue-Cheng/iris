import { describe, expect, it } from 'vitest';
import {
  LeftPanePrefsStore,
  leftPaneTypeKey,
} from './left-pane-prefs';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('left-pane preferences', () => {
  it('uses defaults and stores expansion overrides only', () => {
    const store = new LeftPanePrefsStore(new MemoryStorage());

    expect(store.workspaceOpen('A', '.iris', true)).toBe(true);
    expect(store.workspaceOpen('A', '.iris/child', false)).toBe(false);
    expect(store.typeOpen('A', '.iris', 'issue')).toBe(true);

    store.setWorkspaceOpen('A', '.iris', true, false);
    store.setWorkspaceOpen('A', '.iris/child', false, true);
    store.setTypeOpen('A', '.iris/child', 'issue', false);
    expect(store.getProject('A').workspaces).toEqual({
      '.iris': false,
      '.iris/child': true,
    });
    expect(store.getProject('A').types).toEqual({
      [leftPaneTypeKey('.iris/child', 'issue')]: false,
    });

    store.setWorkspaceOpen('A', '.iris', true, true);
    store.setWorkspaceOpen('A', '.iris/child', false, false);
    store.setTypeOpen('A', '.iris/child', 'issue', true);
    expect(store.getProject('A').workspaces).toEqual({});
    expect(store.getProject('A').types).toEqual({});
  });

  it('persists preferences and isolates projects', () => {
    const storage = new MemoryStorage();
    const first = new LeftPanePrefsStore(storage);
    first.setMode('A', 'files');
    first.setWorkspaceOpen('A', '.iris/child', false, true);
    first.setMode('B', 'git');

    const restored = new LeftPanePrefsStore(storage);
    expect(restored.getMode('A')).toBe('files');
    expect(restored.workspaceOpen('A', '.iris/child', false)).toBe(true);
    expect(restored.getMode('B')).toBe('git');
    expect(restored.workspaceOpen('B', '.iris/child', false)).toBe(false);
  });

  it('reveals a document without retaining default-open values', () => {
    const store = new LeftPanePrefsStore(new MemoryStorage());
    store.setWorkspaceOpen('A', '.iris/child', false, false);
    store.setTypeOpen('A', '.iris/child', 'report', false);

    store.revealDocument('A', '.iris/child', 'report');

    expect(store.workspaceOpen('A', '.iris/child', false)).toBe(true);
    expect(store.typeOpen('A', '.iris/child', 'report')).toBe(true);
    expect(store.getProject('A').types).toEqual({});
  });

  it('removes overrides for paths absent from the latest scan', () => {
    const store = new LeftPanePrefsStore(new MemoryStorage());
    store.setWorkspaceOpen('A', '.iris/keep', false, true);
    store.setWorkspaceOpen('A', '.iris/gone', false, true);
    store.setTypeOpen('A', '.iris/keep', 'issue', false);
    store.setTypeOpen('A', '.iris/gone', 'report', false);
    store.setDirectoryOpen('A', 'keep', false, true);
    store.setDirectoryOpen('A', 'gone', false, true);

    store.reconcileLens(
      'A',
      new Set(['.iris', '.iris/keep']),
      new Set([leftPaneTypeKey('.iris/keep', 'issue')]),
    );
    store.reconcileDirectories('A', new Set(['', 'keep']));

    expect(store.getProject('A').workspaces).toEqual({ '.iris/keep': true });
    expect(store.getProject('A').types).toEqual({
      [leftPaneTypeKey('.iris/keep', 'issue')]: false,
    });
    expect(store.getProject('A').directories).toEqual({ keep: true });
  });

  it('bounds persisted file-tree directory overrides', () => {
    const store = new LeftPanePrefsStore(new MemoryStorage());
    for (let index = 0; index <= 500; index += 1) {
      store.setDirectoryOpen('A', `dir-${index}`, false, true);
    }

    expect(Object.keys(store.getProject('A').directories)).toHaveLength(500);
    expect(store.getProject('A').directories['dir-0']).toBeUndefined();
    expect(store.getProject('A').directories['dir-500']).toBe(true);
  });
});
