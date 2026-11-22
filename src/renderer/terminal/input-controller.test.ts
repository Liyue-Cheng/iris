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
    shellKind: () => 'powershell',
    rejectPath: vi.fn(),
    ...overrides,
  };
  return { runtime, controller: new TerminalInputController(runtime, port), port };
}

describe('TerminalInputController', () => {
  it('drops pending clipboard input across display recovery and refuses new writes while paused', async () => {
    let release!: (value: string) => void;
    const { controller, runtime, port } = fixture({
      readClipboard: () => new Promise(resolve => { release = resolve; }),
    });
    const paste = controller.pasteClipboard();
    runtime.suspendInput();
    await controller.dropPaths(['file.txt']);
    await controller.dropDocument('issue.md');
    await controller.pasteText('must not execute');
    runtime.resumeInput();
    release('late');
    await paste;
    expect(port.readDocument).not.toHaveBeenCalled();
    expect(port.paste).not.toHaveBeenCalled();
    expect(port.sendInput).not.toHaveBeenCalled();
  });

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

  it('checks the epoch after document reads and rejects path drops after disposal', async () => {
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

    const second = fixture();
    second.runtime.dispose();
    await second.controller.dropPaths(['unsafe;name.txt']);
    expect(second.port.sendInput).not.toHaveBeenCalled();
  });

  it('sends literal path arguments for the launch shell without an unsafe confirmation override', async () => {
    const { controller, port } = fixture();
    await controller.dropPaths(["O'Brien.md", '$(echo hi).txt']);
    expect(port.sendInput).toHaveBeenCalledWith("'O''Brien.md' '$(echo hi).txt'");
    expect(port.confirm).not.toHaveBeenCalled();
  });

  it('rejects the whole path drop if cmd would expand any argument', async () => {
    const { controller, port } = fixture({ shellKind: () => 'cmd' });
    await controller.dropPaths(['safe.txt', '%IRIS_PATH%.md']);
    expect(port.rejectPath).toHaveBeenCalledWith('cmd-expansion');
    expect(port.sendInput).not.toHaveBeenCalled();
    expect(port.confirm).not.toHaveBeenCalled();
  });

  it('does not guess a shell when metadata is unknown', async () => {
    const { controller, port } = fixture({ shellKind: () => 'unknown', docDropMode: () => 'path' });
    await controller.dropDocument('task.md');
    expect(port.rejectPath).toHaveBeenCalledWith('unknown-shell');
    expect(port.sendInput).not.toHaveBeenCalled();
  });
});
