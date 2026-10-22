/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawTreeNode } from '@shared/types';
import { RawTree } from '@renderer/components/lens/RawTree';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { openProjectItem } from './shell-actions';
import { IRIS_DOC_MIME } from './doc-drag';
import { lensPrefs } from '@renderer/stores/lens-prefs';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en-US' } }),
}));
vi.mock('@renderer/stores/project-store', () => ({
  useProject: () => ({ scan: null, view: { kind: 'doc', path: 'README.md' } }),
  projectStore: { rescan: vi.fn() },
}));
vi.mock('@renderer/stores/editor-store', () => ({
  editorStore: { flushBeforeSwitch: vi.fn().mockResolvedValue(true) },
}));
vi.mock('./shell-actions', () => ({
  openProjectItem: vi.fn().mockResolvedValue(undefined),
  revealProjectItem: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./clipboard', () => ({ writeClipboardText: vi.fn() }));
vi.mock('./external-actions', () => ({
  addExternalPath: vi.fn(), removeExternalPath: vi.fn(), externalIdentity: vi.fn(),
}));
vi.mock('./action-runtime', () => ({ runUserAction: vi.fn() }));

const tree: RawTreeNode = {
  name: 'project', path: '', absolutePath: 'C:/project', kind: 'dir', mtimeMs: 10,
  children: [
    {
      name: 'src', path: 'src', absolutePath: 'C:/project/src', kind: 'dir', mtimeMs: 10,
      children: [{ name: 'main.ts', path: 'src/main.ts', absolutePath: 'C:/project/src/main.ts', kind: 'file', mtimeMs: 20 }],
    },
    { name: 'README.md', path: 'README.md', absolutePath: 'C:/project/README.md', kind: 'file', mtimeMs: 40 },
    { name: 'package.json', path: 'package.json', absolutePath: 'C:/project/package.json', kind: 'file', mtimeMs: 30 },
  ],
};

let host: HTMLDivElement;
let root: Root;

function row(path: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${path}"]`);
  if (!button) throw new Error(`Missing row: ${path}`);
  return button;
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  lensPrefs.setFilter('');
  if (lensPrefs.get().sort !== 'mtime') lensPrefs.toggleSort();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TooltipProvider, null, createElement(RawTree, { root: tree }))));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('RawTree interactions', () => {
  it('filters deep paths, supports collapsing search results and restores ordinary expansion', async () => {
    await act(async () => lensPrefs.setFilter('SRC\\MAIN.TS'));
    expect(row('src').getAttribute('aria-expanded')).toBe('true');
    expect(row('src/main.ts')).toBeTruthy();
    expect(host.textContent).not.toContain('package.json');
    await act(async () => row('src').click());
    expect(host.textContent).not.toContain('main.ts');
    await act(async () => lensPrefs.setFilter('README'));
    expect(host.textContent).not.toContain('src');
    await act(async () => lensPrefs.setFilter('main.ts'));
    expect(row('src/main.ts')).toBeTruthy();
    await act(async () => lensPrefs.setFilter(''));
    expect(row('src').getAttribute('aria-expanded')).toBe('false');
    expect(row('package.json')).toBeTruthy();
    await act(async () => row('src').click());
    await act(async () => lensPrefs.setFilter('README'));
    await act(async () => lensPrefs.setFilter(''));
    expect(row('src').getAttribute('aria-expanded')).toBe('true');
  });

  it('reacts to the shared sort controls and shows a no-results message', async () => {
    const paths = () => Array.from(host.querySelectorAll('button[aria-label]')).map((button) => button.getAttribute('aria-label'));
    expect(paths()).toEqual(['project', 'src', 'README.md', 'package.json']);
    await act(async () => lensPrefs.toggleSort());
    // Folders remain first in both modes.
    expect(paths()).toEqual(['project', 'src', 'package.json', 'README.md']);
    await act(async () => lensPrefs.setFilter('no-such-file'));
    expect(host.querySelector('[role="status"]')?.textContent).toBe('layout.noMatchingFiles');
    await act(async () => lensPrefs.setFilter(''));
    expect(row('package.json')).toBeTruthy();
  });

  it('selects any file independently of the editor and retains system opening', async () => {
    expect(host.querySelector('[aria-current="true"]')).toBeNull();
    await act(async () => row('package.json').click());
    expect(row('package.json').getAttribute('aria-current')).toBe('true');
    expect(row('README.md').hasAttribute('aria-current')).toBe(false);
    expect(openProjectItem).toHaveBeenLastCalledWith('package.json');
    expect(row('package.json').hasAttribute('title')).toBe(false);
    await act(async () => row('package.json').focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('C:/project/package.json');

    await act(async () => row('README.md').click());
    expect(row('README.md').getAttribute('aria-current')).toBe('true');
    expect(row('package.json').hasAttribute('aria-current')).toBe(false);
    expect(openProjectItem).toHaveBeenLastCalledWith('README.md');
  });

  it('starts with only the root expanded and selects folders without opening them externally', async () => {
    expect(row('project').getAttribute('aria-expanded')).toBe('true');
    expect(row('src').getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('main.ts');
    await act(async () => row('src').click());
    expect(row('src').getAttribute('aria-expanded')).toBe('true');
    expect(row('src').getAttribute('aria-current')).toBe('true');
    expect(row('src/main.ts').hasAttribute('title')).toBe(false);
    await act(async () => row('src/main.ts').focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('C:/project/src/main.ts');
    await act(async () => row('src').click());
    expect(host.textContent).not.toContain('main.ts');
    expect(openProjectItem).not.toHaveBeenCalled();
  });

  it('preserves both path drag formats and selects the dragged file', async () => {
    const setData = vi.fn();
    const dataTransfer = { setData, effectAllowed: 'none' };
    const event = new Event('dragstart', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    await act(async () => row('package.json').dispatchEvent(event));
    expect(setData).toHaveBeenCalledWith(IRIS_DOC_MIME, 'package.json');
    expect(setData).toHaveBeenCalledWith('text/plain', 'package.json');
    expect(dataTransfer.effectAllowed).toBe('copy');
    expect(row('package.json').getAttribute('aria-current')).toBe('true');
    expect(openProjectItem).not.toHaveBeenCalled();
  });

  it('selects the context-menu target without opening the file', async () => {
    await act(async () => row('package.json').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
    ));
    expect(row('package.json').getAttribute('aria-current')).toBe('true');
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('common.copyPath');
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('common.openDefault');
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('common.reveal');
    expect(openProjectItem).not.toHaveBeenCalled();
  });
});
