// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IrisAgentTerminalView } from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { AgentTerminalDialog } from '@renderer/components/agent/AgentTerminalDialog';
import { projectScopeState } from '@renderer/stores/project-scope-state';

const harness = vi.hoisted(() => ({
  clipboard: vi.fn<() => Promise<string | null>>(),
  confirm: vi.fn<() => Promise<boolean>>(),
  invoke: vi.fn(),
  bracketed: true,
  rightClick: 'menu',
  adapters: [] as Array<{
    paste: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    key: (event: KeyboardEvent) => boolean;
    textarea: HTMLTextAreaElement;
  }>,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/i18n', () => ({ rendererI18n: { language: 'en' } }));
vi.mock('@renderer/lib/clipboard', () => ({ readClipboardText: harness.clipboard, writeClipboardText: vi.fn() }));
vi.mock('@renderer/components/ui/confirm-dialog', () => ({ confirmDialog: harness.confirm }));
vi.mock('@renderer/stores/notification-store', () => ({ notify: vi.fn() }));
vi.mock('@renderer/stores/settings-store', () => ({
  useSettings: () => null,
  getSettings: () => ({ behavior: { terminalRightClick: harness.rightClick }, appearance: {}, advanced: {} }),
}));
vi.mock('@renderer/components/agent/AgentWorkbenchDialog', () => ({
  AgentWorkbenchDialog: ({ children }: { children: ReactNode }) => children,
  AgentStatusBadge: () => null,
}));
vi.mock('@renderer/components/terminal/TerminalContextMenu', () => ({
  TerminalContextMenu: ({ children, onPaste }: { children: ReactNode; onPaste(): void }) =>
    createElement('div', null, createElement('button', { onClick: onPaste, 'data-paste': true }, 'Paste'), children),
}));
vi.mock('@renderer/terminal/replay-controller', () => ({
  TerminalReplayController: class {
    start = async (): Promise<void> => undefined;
    onOutput = (): void => undefined;
  },
}));
vi.mock('@renderer/terminal/viewport-controller', () => ({
  TerminalViewportController: class {
    observe = (): void => undefined;
    flushBeforeInput = (): void => undefined;
    dispose = (): void => undefined;
  },
}));
vi.mock('@renderer/terminal/xterm-adapter', () => ({
  BrowserXtermAdapter: class {
    private input: ((data: string, encoding: 'utf8') => void) | null = null;
    private state = {
      paste: vi.fn((text: string) => {
        this.input?.(harness.bracketed ? `\x1b[200~${text}\x1b[201~` : text, 'utf8');
      }),
      focus: vi.fn(),
      key: (_event: KeyboardEvent): boolean => true,
      textarea: document.createElement('textarea'),
    };
    terminal = {
      modes: { get bracketedPasteMode() { return harness.bracketed; } },
      paste: this.state.paste,
      focus: this.state.focus,
      onResize: () => ({ dispose: vi.fn() }),
      attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => { this.state.key = handler; },
      getSelection: () => '',
      clearSelection: vi.fn(),
    };
    fit = { fit: vi.fn() };
    search = { onDidChangeResults: () => ({ dispose: vi.fn() }), clearDecorations: vi.fn() };
    constructor() { harness.adapters.push(this.state); }
    open(host: HTMLElement): void {
      this.state.textarea.className = 'xterm-helper-textarea';
      host.append(this.state.textarea);
    }
    onInput(listener: (data: string, encoding: 'utf8') => void): { dispose(): void } {
      this.input = listener;
      return { dispose: () => { this.input = null; } };
    }
    dispose(): void {}
  },
}));

const terminal: IrisAgentTerminalView = {
  id: 'terminal-1', toolActivityId: 'activity-1', command: 'pwsh', cwd: 'C:/project',
  revealed: true, state: 'running', startedAt: 0, userInput: true,
};
let host: HTMLDivElement;
let root: Root;

async function render(id = terminal.id): Promise<void> {
  await act(async () => root.render(createElement(AgentTerminalDialog, {
    sessionId: 'agent-1', terminal: { ...terminal, id }, onClose: vi.fn(),
  })));
}

function inputCalls(): unknown[][] {
  return harness.invoke.mock.calls.filter(([channel]) => channel === CHANNELS.IRIS_AGENT_TERMINAL_INPUT);
}

function nativePaste(): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  harness.adapters.at(-1)!.textarea.dispatchEvent(event);
  return event;
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  harness.adapters.length = 0;
  harness.bracketed = true;
  harness.rightClick = 'menu';
  harness.clipboard.mockReset().mockResolvedValue('first\nsecond\n');
  harness.confirm.mockReset().mockResolvedValue(true);
  harness.invoke.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('api', { windowsBuild: null, invoke: harness.invoke, on: () => () => undefined });
  projectScopeState.set({ root: 'C:/project', generation: 7 });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  projectScopeState.set(null);
  vi.unstubAllGlobals();
});

describe('Agent terminal input entry points', () => {
  it('routes menu paste through the shared controller and the mount-bound transport', async () => {
    projectScopeState.set({ root: 'C:/other-project', generation: 8 });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-paste]')!.click());
    expect(harness.adapters[0]!.paste).toHaveBeenCalledWith('first\nsecond\n');
    expect(inputCalls()).toEqual([[CHANNELS.IRIS_AGENT_TERMINAL_INPUT, {
      sessionId: 'agent-1', terminalId: 'terminal-1', data: '\x1b[200~first\nsecond\n\x1b[201~',
      expectedScope: { root: 'C:/project', generation: 7 },
    }]]);
  });

  it('routes direct right-click paste through the same confirmation path', async () => {
    harness.rightClick = 'paste';
    harness.bracketed = false;
    harness.confirm.mockResolvedValue(false);
    await act(async () => {
      harness.adapters[0]!.textarea.parentElement!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(harness.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'terminal.multilineTitle' }));
    expect(harness.adapters[0]!.paste).not.toHaveBeenCalled();
    expect(inputCalls()).toEqual([]);
  });

  it.each([
    { key: 'v', ctrlKey: true },
    { key: 'V', ctrlKey: true, shiftKey: true },
    { key: 'Insert', shiftKey: true },
  ])('consumes $key shortcut bytes and handles the following native paste once', async (keys) => {
    const adapter = harness.adapters[0]!;
    expect(adapter.key(new KeyboardEvent('keydown', keys))).toBe(false);
    expect(harness.clipboard).not.toHaveBeenCalled();
    const bubbleHandler = vi.fn();
    adapter.textarea.addEventListener('paste', bubbleHandler);
    await act(async () => { expect(nativePaste().defaultPrevented).toBe(true); });
    expect(bubbleHandler).not.toHaveBeenCalled();
    expect(harness.clipboard).toHaveBeenCalledOnce();
    expect(adapter.paste).toHaveBeenCalledOnce();
    expect(inputCalls()).toHaveLength(1);
  });

  it('preserves IME and unselected Ctrl+C keyboard input', () => {
    const key = harness.adapters[0]!.key;
    expect(key(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, isComposing: true }))).toBe(true);
    expect(key(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))).toBe(true);
  });

  it('discards clipboard results after unmount and removes native paste listeners', async () => {
    let resolveClipboard!: (text: string) => void;
    harness.clipboard.mockImplementation(() => new Promise((resolve) => { resolveClipboard = resolve; }));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-paste]')!.click());
    const old = harness.adapters[0]!;
    await act(async () => root.render(null));
    const event = new Event('paste', { bubbles: true, cancelable: true });
    old.textarea.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await act(async () => resolveClipboard('late input\n'));
    expect(old.paste).not.toHaveBeenCalled();
    expect(old.focus).not.toHaveBeenCalled();
    expect(inputCalls()).toEqual([]);
    expect(harness.clipboard).toHaveBeenCalledOnce();
  });

  it('does not redirect a pending paste to a new terminal mount', async () => {
    let resolveClipboard!: (text: string) => void;
    harness.clipboard.mockImplementationOnce(() => new Promise((resolve) => { resolveClipboard = resolve; }));
    await act(async () => { nativePaste(); });
    await render('terminal-2');
    await act(async () => resolveClipboard('old terminal input'));
    expect(harness.adapters[0]!.paste).not.toHaveBeenCalled();
    expect(harness.adapters[1]!.paste).not.toHaveBeenCalled();
    expect(inputCalls()).toEqual([]);
    await act(async () => { nativePaste(); });
    expect(inputCalls()).toHaveLength(1);
    expect(inputCalls()[0]![1]).toMatchObject({ terminalId: 'terminal-2' });
  });

  it('discards confirmation results that arrive after unmount', async () => {
    harness.bracketed = false;
    let resolveConfirmation!: (accepted: boolean) => void;
    harness.confirm.mockImplementation(() => new Promise((resolve) => { resolveConfirmation = resolve; }));
    await act(async () => { nativePaste(); });
    expect(harness.confirm).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    await act(async () => resolveConfirmation(true));
    expect(harness.adapters[0]!.paste).not.toHaveBeenCalled();
    expect(inputCalls()).toEqual([]);
  });
});
