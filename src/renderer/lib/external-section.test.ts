/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceExternalPaths } from '@shared/types';
import { ExternalSection } from '@renderer/components/lens/ExternalSection';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import { lensPrefs } from '@renderer/stores/lens-prefs';
import { addExternalPath, listExternalPaths } from './external-actions';
import { notify } from '@renderer/stores/notification-store';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/i18n', () => ({ translate: (key: string) => key }));
vi.mock('@renderer/stores/notification-store', () => ({ notify: vi.fn() }));
vi.mock('@renderer/stores/editor-store', () => ({ editorStore: {} }));
vi.mock('./external-actions', () => ({
  addExternalPath: vi.fn(), listExternalPaths: vi.fn(), externalIdentity: vi.fn(),
  openExternalPath: vi.fn(), pickExternalPath: vi.fn(), removeExternalPath: vi.fn(),
  revealExternalPath: vi.fn(),
}));

const empty: WorkspaceExternalPaths = {
  workspacePath: '.iris/child', manifestPath: '.iris/child/external.txt',
  exists: false, entries: [], diagnostics: [],
};
const populated: WorkspaceExternalPaths = {
  ...empty, exists: true,
  entries: [{ name: 'file.txt', storedPath: 'C:/file.txt', absolutePath: 'C:/file.txt',
    kind: 'file', exists: true, line: 0, error: null }],
};
let host: HTMLDivElement;
let root: Root;
const resolvePath = vi.fn((file: File) => `C:/${file.name}`);

function region(): HTMLElement {
  return host.querySelector<HTMLElement>('[role="region"]')!;
}

function transfer(names: string[] = [], types = ['Files']): DataTransfer {
  return { types, files: names.map((name) => new File([], name)), dropEffect: 'none' } as unknown as DataTransfer;
}

function drag(type: string, dt: DataTransfer, target: EventTarget = region()): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dt });
  target.dispatchEvent(event);
  return event;
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  resolvePath.mockImplementation((file) => `C:/${file.name}`);
  vi.stubGlobal('api', { getPathForFile: resolvePath });
  projectScopeState.set({ root: 'C:/project', generation: 1 });
  lensPrefs.setFilter('');
  vi.mocked(addExternalPath).mockReset().mockResolvedValue(populated.entries[0]!);
  vi.mocked(listExternalPaths).mockReset().mockResolvedValue(populated);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(ExternalSection, { external: empty })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  projectScopeState.set(null);
  vi.unstubAllGlobals();
});

describe('External section and native file drops', () => {
  it('keeps the title and add control for a missing, empty or filtered manifest', async () => {
    expect(region()).not.toBeNull();
    expect(host.textContent).toContain('External');
    expect(host.textContent).toContain('external.dropHint');
    expect(host.querySelector('[aria-label="external.add"]')).not.toBeNull();
    await act(async () => root.render(createElement(ExternalSection, { external: { ...empty, exists: true } })));
    expect(region()).not.toBeNull();
    await act(async () => root.render(createElement(ExternalSection, { external: populated })));
    await act(async () => lensPrefs.setFilter('no-match'));
    expect(region()).not.toBeNull();
    expect(host.textContent).not.toContain('file.txt');
    await act(async () => root.render(createElement(ExternalSection, { external: empty })));
    expect(host.textContent).toContain('external.dropHint');
  });

  it('highlights a native drag with protected file data and keeps the highlight across children', async () => {
    const dt = transfer();
    const child = host.querySelector('button')!;
    await act(async () => { drag('dragenter', dt); });
    expect(host.querySelector('[role="status"]')?.textContent).toBe('external.dropRelease');
    await act(async () => { drag('dragenter', dt, child); drag('dragleave', dt, child); });
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => { expect(drag('dragover', dt).defaultPrevented).toBe(true); });
    expect(dt.dropEffect).toBe('copy');
    await act(async () => { drag('dragleave', dt); });
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => { drag('dragenter', dt); window.dispatchEvent(new Event('blur')); });
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('adds multiple files and directories once to the receiving workspace and refreshes rows', async () => {
    const dt = transfer(['file.txt', 'folder', 'file.txt']);
    await act(async () => { drag('dragenter', dt); });
    await act(async () => { expect(drag('drop', dt).defaultPrevented).toBe(true); });
    expect(addExternalPath).toHaveBeenNthCalledWith(1, '.iris/child', 'C:/file.txt');
    expect(addExternalPath).toHaveBeenNthCalledWith(2, '.iris/child', 'C:/folder');
    expect(addExternalPath).toHaveBeenCalledTimes(2);
    expect(listExternalPaths).toHaveBeenCalledWith('.iris/child');
    expect(host.querySelector('[aria-label="C:/file.txt"]')).not.toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(region().getAttribute('aria-busy')).toBe('false');
  });

  it('accepts a drop on its collapsed header and opens the resulting list', async () => {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="layout.collapse"]')!.click());
    expect(host.textContent).not.toContain('external.dropHint');
    await act(async () => { drag('drop', transfer(['file.txt']), host.querySelector('button')!); });
    expect(host.querySelector('[aria-label="C:/file.txt"]')).not.toBeNull();
  });

  it('ignores plain text, URLs and Iris outbound path drags', async () => {
    for (const type of ['text/plain', 'text/uri-list', 'application/x-iris-external-path']) {
      await act(async () => {
        const dt = transfer([], [type]);
        expect(drag('dragenter', dt).defaultPrevented).toBe(false);
        expect(drag('drop', dt).defaultPrevented).toBe(false);
      });
    }
    expect(addExternalPath).not.toHaveBeenCalled();
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('retains successful additions and reports unavailable paths and individual write failures', async () => {
    resolvePath.mockImplementation((file) => file.name === 'virtual' ? '' : `C:/${file.name}`);
    vi.mocked(addExternalPath).mockRejectedValueOnce(new Error('write failed'));
    await act(async () => { drag('drop', transfer(['bad.txt', 'folder', 'virtual'])); });
    expect(addExternalPath).toHaveBeenCalledTimes(2);
    expect(listExternalPaths).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'external.addFailed', message: expect.stringContaining('external.dropPathFailed'),
    }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('write failed') }));
    expect(region().getAttribute('aria-busy')).toBe('false');
  });

  it('serializes a batch and refuses another drop while adding', async () => {
    let release!: () => void;
    vi.mocked(addExternalPath).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(populated.entries[0]!);
    }));
    await act(async () => { drag('drop', transfer(['file.txt', 'folder'])); });
    expect(region().getAttribute('aria-busy')).toBe('true');
    expect(addExternalPath).toHaveBeenCalledTimes(1);
    await act(async () => {
      const dt = transfer(['ignored']);
      drag('dragover', dt);
      expect(dt.dropEffect).toBe('none');
      drag('drop', dt);
    });
    expect(addExternalPath).toHaveBeenCalledTimes(1);
    await act(async () => release());
    expect(addExternalPath).toHaveBeenCalledTimes(2);
    expect(region().getAttribute('aria-busy')).toBe('false');
  });

  it('stops a pending batch when the project changes', async () => {
    vi.mocked(addExternalPath).mockImplementationOnce(async () => {
      projectScopeState.set({ root: 'C:/other-project', generation: 2 });
      return populated.entries[0]!;
    });
    await act(async () => { drag('drop', transfer(['file.txt', 'folder'])); });
    expect(addExternalPath).toHaveBeenCalledTimes(1);
    expect(listExternalPaths).not.toHaveBeenCalled();
  });
});
