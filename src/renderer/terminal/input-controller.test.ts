import { describe, expect, it, vi } from 'vitest';
import { TerminalInputController, type TerminalInputPort } from './input-controller';
import { TerminalSessionRuntime } from './terminal-runtime';

function fixture(overrides: Partial<TerminalInputPort> = {}): {
  runtime: TerminalSessionRuntime;
  controller: TerminalInputController;
  port: TerminalInputPort;
} {
  const runtime = new TerminalSessionRuntime('session-1', { root: 'C:\\work', generation: 1 });
  const port: TerminalInputPort = {
    bracketedPasteMode: () => true,
    paste: vi.fn(),
    focus: vi.fn(),
    sendInput: vi.fn(async () => undefined),
    readClipboard: vi.fn(async () => 'clipboard'),
    readDocument: vi.fn(async () => 'document'),
    confirm: vi.fn(async () => true),
    docDropMode: () => 'content',
    ...overrides,
  };
  return { runtime, controller: new TerminalInputController(runtime, port), port };
}

describe('TerminalInputController', () => {
  it('does not paste a clipboard result that arrives after runtime disposal', async () => {
    let resolveClipboard: (text: string) => void = () => undefined;
    const clipboard = new Promise<string>((resolve) => {
      resolveClipboard = resolve;
    });
    const { runtime, controller, port } = fixture({ readClipboard: () => clipboard });
    const operation = controller.pasteClipboard();
    runtime.dispose();
    resolveClipboard('late');
    await operation;
    expect(port.paste).not.toHaveBeenCalled();
  });

  it('checks the epoch after every confirmation', async () => {
    const { runtime, controller, port } = fixture({
      bracketedPasteMode: () => false,
      confirm: vi.fn(async () => {
        runtime.dispose();
        return true;
      }),
    });
    await controller.pasteText('one\ntwo\x1b');
    expect(port.confirm).toHaveBeenCalledOnce();
    expect(port.paste).not.toHaveBeenCalled();
  });

  it('checks the epoch after document reads and shell-meta confirmation', async () => {
    let resolveDocument: (text: string) => void = () => undefined;
    const document = new Promise<string>((resolve) => {
      resolveDocument = resolve;
    });
    const first = fixture({ readDocument: () => document });
    const operation = first.controller.dropDocument('task.md');
    first.runtime.dispose();
    resolveDocument('late document');
    await operation;
    expect(first.port.paste).not.toHaveBeenCalled();

    const second = fixture({
      confirm: vi.fn(async () => {
        second.runtime.dispose();
        return true;
      }),
    });
    await second.controller.dropPaths(['unsafe;name.txt']);
    expect(second.port.sendInput).not.toHaveBeenCalled();
  });
});
