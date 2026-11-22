// @vitest-environment jsdom
// Real component state/handlers; layout, i18n and terminal drawing are stubbed.
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CHANNELS } from '@shared/protocol';
import { getNotifications, clearNotifications } from '@renderer/stores/notification-store';
import { irisAgentStore } from '@renderer/stores/iris-agent-store';
import type { IrisAgentSessionInfo } from '@shared/types';
import { projectScopeState } from '@renderer/stores/project-scope-state';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), dispatch: vi.fn(), on: vi.fn(() => () => {}) }));
vi.mock('@renderer/cpu', () => ({ pipeline: { dispatch: mocks.dispatch } }));
vi.mock('@renderer/i18n', () => ({ translate: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/stores/settings-store', () => ({ getSettings: () => null, useSettings: () => null }));
vi.mock('@renderer/components/ui/confirm-dialog', () => ({ alertDialog: vi.fn(), confirmDialog: vi.fn() }));
vi.mock('@renderer/components/ui/button', () => ({ Button: ({ children, onClick, disabled, title, type }: any) =>
  createElement('button', { onClick, disabled, title, type }, children) }));
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => open ? createElement(Fragment, null, children) : null,
  DialogContent: ({ children }: any) => createElement('section', null, children),
  DialogHeader: ({ children }: any) => createElement('div', null, children),
  DialogTitle: ({ children }: any) => createElement('h1', null, children),
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => createElement(Fragment, null, children),
  TooltipTrigger: ({ children }: any) => createElement(Fragment, null, children),
  TooltipContent: () => null,
}));
vi.mock('@renderer/terminal/xterm-adapter', () => ({ BrowserXtermAdapter: class {} }));
vi.mock('@renderer/components/terminal/TerminalSurface', () => ({ TerminalSurface: () => null }));
vi.mock('@renderer/components/agent/AgentWorkbenchDialog', () => ({
  AgentWorkbenchDialog: ({ actions, children }: any) => createElement('section', null, actions, children),
  AgentStatusBadge: () => null,
}));

let AssetPanel: typeof import('@renderer/components/doc/AssetPanel').AssetPanel;
let AgentTaskDialog: typeof import('@renderer/components/agent/AgentTaskDialog').AgentTaskDialog;
let projectStore: typeof import('@renderer/stores/project-store').projectStore;
let root: Root;
let host: HTMLDivElement;
beforeAll(async () => {
  Object.assign(window, { api: { invoke: mocks.invoke, on: mocks.on } });
  ({ projectStore } = await import('@renderer/stores/project-store'));
  ({ AssetPanel } = await import('@renderer/components/doc/AssetPanel'));
  ({ AgentTaskDialog } = await import('@renderer/components/agent/AgentTaskDialog'));
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.invoke.mockReset(); mocks.dispatch.mockReset(); mocks.on.mockClear(); clearNotifications();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearNotifications(); });

function deferred() {
  let resolve!: (value: unknown) => void; let reject!: (error: unknown) => void;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const scope = { root: 'E:/audit/a', generation: 501 };
function opened() {
  projectStore.handleOpened({ scope, sessions: [], scan: { projectRoot: scope.root, projectName: 'audit', hasIris: true,
    scannedAt: 1, root: { path: '.iris', name: 'audit', docs: [], children: [],
      external: { workspacePath: '.iris', manifestPath: '.iris/external.txt', exists: false, entries: [], diagnostics: [] } } } });
  irisAgentStore.reset([{
    id: 'agent-1', projectRoot: scope.root, projectGeneration: scope.generation,
    revision: 1, state: 'ready',
  } as IrisAgentSessionInfo], scope);
}

it('AssetPanel for document B discards the late error from document A after B succeeds', async () => {
  opened();
  const old = deferred(); const current = deferred();
  mocks.invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await act(async () => root.render(createElement(AssetPanel, { docPath: '.iris/issue/a.md', open: true, onOpenChange: () => {} })));
  await act(async () => root.render(createElement(AssetPanel, { docPath: '.iris/issue/b.md', open: true, onOpenChange: () => {} })));
  expect(mocks.invoke.mock.calls.map(([channel, payload]) => [channel, payload.docPath])).toEqual([
    [CHANNELS.ASSET_LIST, '.iris/issue/a.md'], [CHANNELS.ASSET_LIST, '.iris/issue/b.md'],
  ]);
  await act(async () => current.resolve({ docPath: '.iris/issue/b.md', directoryPath: '.iris/issue/b.assets', assets: [], associated: [] }));
  expect(host.textContent).not.toContain('old document A failed');
  await act(async () => old.reject(new Error('old document A failed')));
  expect(host.textContent).not.toContain('old document A failed');
});

it('the real task cancel button becomes available after a rejected request', async () => {
  opened(); mocks.invoke.mockRejectedValueOnce(new Error('cancel failed'));
  const task = { taskId: 'task-1', title: 'task', command: 'echo audit', cwd: '.', status: 'running', outputBytes: 0 };
  await act(async () => root.render(createElement(AgentTaskDialog, { sessionId: 'agent-1', task: task as any, onClose: () => {} })));
  const button = Array.from(host.querySelectorAll('button')).find(el => el.textContent === '取消任务')!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(getNotifications()).toMatchObject([{ message: 'cancel failed', title: '后台任务取消失败' }]);
  expect(button.textContent).toBe('取消任务');
  expect(button.disabled).toBe(false);

  mocks.invoke.mockResolvedValueOnce(irisAgentStore.get().sessions[0]);
  await act(async () => button.click());
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(button.textContent).toContain('取消中');
  expect(button.disabled).toBe(true);
  expect(getNotifications()).toHaveLength(0);
  await act(async () => root.render(createElement(AgentTaskDialog, {
    sessionId: 'agent-1', task: { ...task, status: 'completed' } as any, onClose: () => {},
  })));
  expect(host.textContent).not.toContain('取消中');
});

it('an older refresh cannot restore an error after a watcher refresh succeeds', async () => {
  opened();
  const old = deferred(); const current = deferred();
  mocks.invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const path = '.iris/issue/a.md';
  await act(async () => root.render(createElement(AssetPanel, { docPath: path, open: true, onOpenChange: () => {} })));
  const listener = (mocks.on.mock.calls[0] as unknown as [string, (event: unknown) => void])[1];
  await act(async () => listener({ changes: [{ path }] }));
  await act(async () => current.resolve({ directoryPath: '.iris/issue/a.assets', assets: [], associated: [] }));
  await act(async () => old.reject(new Error('older refresh failed')));
  expect(host.textContent).not.toContain('older refresh failed');
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it('the same document path in a new project does not inherit the old resource error', async () => {
  opened();
  const old = deferred();
  mocks.invoke.mockReturnValueOnce(old.promise).mockResolvedValue({ assets: [], associated: [] });
  await act(async () => root.render(createElement(AssetPanel, { docPath: '.iris/issue/a.md', open: true, onOpenChange: () => {} })));
  const next = { root: 'E:/audit/b', generation: 502 };
  await act(async () => projectScopeState.set(next));
  await act(async () => old.reject(new Error('old project error')));
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(mocks.invoke.mock.calls[1]![1]).toMatchObject({ expectedScope: next });
  expect(host.textContent).not.toContain('old project error');
});

it('closing and reopening the panel retires a pending path picker without linking its result', async () => {
  opened();
  const picker = deferred();
  mocks.invoke.mockImplementation((channel: string) => channel === CHANNELS.DIALOG_PICK_ASSET_PATH
    ? picker.promise : Promise.resolve({ directoryPath: '.iris/issue/a.assets', assets: [], associated: [] }));
  const props = { docPath: '.iris/issue/a.md', open: true, onOpenChange: () => {} };
  await act(async () => root.render(createElement(AssetPanel, props)));
  const add = Array.from(host.querySelectorAll('button')).find(el => el.textContent?.includes('editor.addAssociatedFile'))!;
  await act(async () => add.click());
  await act(async () => root.render(createElement(AssetPanel, { ...props, open: false })));
  await act(async () => root.render(createElement(AssetPanel, props)));
  await act(async () => picker.resolve('E:/external/file.txt'));
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it('a delayed file read cannot import into a document or project after its panel is retired', async () => {
  opened();
  const bytes = deferred();
  mocks.invoke.mockResolvedValue({ directoryPath: '.iris/issue/a.assets', assets: [], associated: [] });
  const props = { docPath: '.iris/issue/a.md', open: true, onOpenChange: () => {} };
  await act(async () => root.render(createElement(AssetPanel, props)));
  const input = host.querySelector('input')!;
  Object.defineProperty(input, 'files', { value: [{ name: 'test.png', type: 'image/png', arrayBuffer: () => bytes.promise }] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => root.render(createElement(AssetPanel, { ...props, docPath: '.iris/issue/b.md' })));
  await act(async () => bytes.resolve(new Uint8Array([1]).buffer));
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('Asset import belongs');
});
