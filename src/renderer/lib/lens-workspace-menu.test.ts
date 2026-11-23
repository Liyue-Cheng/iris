/** @vitest-environment jsdom */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IrisWorkspace } from '@shared/types';
import { LensTree } from '@renderer/components/lens/LensTree';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { openCreateDialog } from '@renderer/components/doc/CreateDocDialog';
import { projectStore } from '@renderer/stores/project-store';
import { openWorkspaceSession } from './session-actions';
import { openProjectItem, revealProjectItem } from './shell-actions';
import { writeClipboardText } from './clipboard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en-US' } }),
}));
vi.mock('@renderer/stores/project-store', () => ({
  useProject: () => ({ view: { kind: 'doc', path: null }, scope: { root: 'C:\\project', generation: 1 } }),
  projectStore: {
    openTodos: vi.fn(), selectRoot: vi.fn(), selectWorkspace: vi.fn(),
    selectDoc: vi.fn(), openCollection: vi.fn(), activateSession: vi.fn(),
  },
}));
vi.mock('@renderer/stores/settings-store', () => ({
  useSettings: () => ({
    agents: [{ id: 'claude', label: 'Claude', command: 'claude' }],
    experimental: { irisAgent: false },
  }),
}));
vi.mock('@renderer/stores/session-view-store', () => ({
  sessionViewStore: { select: vi.fn() },
  useSelectedSessionView: () => null,
}));
vi.mock('@renderer/lib/session-projection', () => ({
  useSessionProjections: () => [{
    key: 'terminal:root-session', kind: 'terminal', id: 'root-session',
    anchor: { kind: 'workspace', path: '.iris' }, title: 'Root terminal',
    subtitle: 'Shell', indicator: 'idle', busy: false, createdAt: 1, updatedAt: 1,
    capabilities: { close: true, select: true },
  }],
  aggregateProjectionState: () => null,
  sessionProjectionAnchorKey: (anchor: { kind: string; path: string }) =>
    anchor.kind === 'document' ? anchor.path : `ws:${anchor.path}`,
}));
vi.mock('./session-actions', () => ({ openWorkspaceSession: vi.fn() }));
vi.mock('./iris-agent-actions', () => ({ openIrisAgent: vi.fn() }));
vi.mock('./session-projection-actions', () => ({ closeProjectedSession: vi.fn() }));
vi.mock('./shell-actions', () => ({
  openProjectItem: vi.fn().mockResolvedValue(undefined),
  revealProjectItem: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./clipboard', () => ({ writeClipboardText: vi.fn() }));
vi.mock('@renderer/components/layout/RightPane', () => ({ LauncherMenuItems: () => null }));
vi.mock('@renderer/components/lens/ExternalSection', () => ({ ExternalSection: () => null }));
vi.mock('@renderer/components/doc/CreateDocDialog', () => ({ openCreateDialog: vi.fn() }));
vi.mock('@renderer/components/doc/DocContextMenu', () => ({
  DocContextMenu: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@renderer/components/project/CreateWorkspaceDialog', () => ({
  CreateWorkspaceDialog: ({ open, defaultParent }: { open: boolean; defaultParent?: string }) =>
    open ? createElement('div', { 'data-testid': 'create-workspace' }, defaultParent) : null,
}));

const external = { workspacePath: '.iris', entries: [] };
const tree = {
  name: 'project', path: '.iris', docs: [], external,
  children: [
    { name: 'spike', path: '.iris/spike', docs: [], children: [], external: { ...external, workspacePath: '.iris/spike' } },
  ],
} as unknown as IrisWorkspace;

let host: HTMLDivElement;
let root: Root;

function header(label: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing header: ${label}`);
  return button;
}

async function openMenu(label: string): Promise<HTMLElement> {
  await act(async () => header(label).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
  ));
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error('Context menu did not open');
  return menu;
}

function item(menu: HTMLElement, text: string): HTMLElement {
  const found = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((el) => el.textContent?.includes(text));
  if (!found) throw new Error(`Missing menu item: ${text}`);
  return found;
}

async function choose(label: string, text: string): Promise<void> {
  const menu = await openMenu(label);
  await act(async () => item(menu, text).click());
}

async function openSubmenu(menu: HTMLElement, text: string): Promise<HTMLElement> {
  const trigger = item(menu, text);
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  const menus = document.querySelectorAll<HTMLElement>('[role="menu"]');
  return menus[menus.length - 1]!;
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TooltipProvider, null, createElement(LensTree, { root: tree }))));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

describe('workspace header context menu', () => {
  it('opens on the root header with file operations for the .iris folder', async () => {
    const menu = await openMenu('layout.rootHubHint');
    expect(menu.textContent).toContain('layout.projectRoot');

    await act(async () => item(menu, 'common.copyPath').click());
    expect(writeClipboardText).toHaveBeenCalledWith('.iris');

    await choose('layout.rootHubHint', 'layout.copyAbsolutePath');
    expect(writeClipboardText).toHaveBeenLastCalledWith('C:\\project\\.iris');

    await choose('layout.rootHubHint', 'layout.openFolder');
    expect(openProjectItem).toHaveBeenCalledWith('.iris');

    await choose('layout.rootHubHint', 'common.reveal');
    expect(revealProjectItem).toHaveBeenCalledWith('.iris');

    await choose('layout.rootHubHint', 'layout.workspaceTodos');
    expect(projectStore.openTodos).toHaveBeenCalledWith(null);
  });

  it('scopes create actions to the right-clicked workspace', async () => {
    const menu = await openMenu('layout.workspaceHubHint');
    expect(menu.textContent).toContain('spike');

    const docs = await openSubmenu(menu, 'layout.newDocumentMenu');
    await act(async () => item(docs, 'issue').click());
    expect(openCreateDialog).toHaveBeenCalledWith({ workspacePath: '.iris/spike', type: 'issue' });

    const sessions = await openSubmenu(await openMenu('layout.workspaceHubHint'), 'layout.newSession');
    await act(async () => item(sessions, 'layout.openWith').click());
    expect(openWorkspaceSession).toHaveBeenCalledWith('.iris/spike', 'claude');

    await choose('layout.workspaceHubHint', 'layout.newSubWorkspace');
    expect(host.querySelector('[data-testid="create-workspace"]')?.textContent).toBe('.iris/spike');

    await choose('layout.workspaceHubHint', 'layout.workspaceTodos');
    expect(projectStore.openTodos).toHaveBeenCalledWith('.iris/spike');
  });

  it('folds and unfolds the workspace sessions and document sections together', async () => {
    const before = host.querySelectorAll('[data-collection-entry-type]').length;
    expect(before).toBe(4);
    expect(host.textContent).toContain('Root terminal');
    await choose('layout.rootHubHint', 'layout.collapseDocuments');
    expect(host.querySelectorAll('[data-collection-entry-type]').length).toBe(0);
    expect(host.textContent).not.toContain('Root terminal');
    await choose('layout.rootHubHint', 'layout.expandDocuments');
    expect(host.querySelectorAll('[data-collection-entry-type]').length).toBe(4);
    expect(host.textContent).toContain('Root terminal');
  });
});
