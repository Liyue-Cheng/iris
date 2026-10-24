// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { BrowserXtermAdapter } from './xterm-adapter';

// These tests exercise input, not canvas rendering. xterm probes canvas at import.
vi.hoisted(() => { HTMLCanvasElement.prototype.getContext = () => null; });

describe('BrowserXtermAdapter input', () => {
  it('suppresses parser replies while forwarding actual text, SGR mouse and focus input', async () => {
    const adapter = new BrowserXtermAdapter({
      fontFamily: 'monospace', fontSize: 13, lineHeight: 1.2,
      themeId: undefined, renderer: 'dom', windowsBuild: null, openLink: () => undefined,
    });
    const listener = vi.fn();
    const subscription = adapter.onInput(listener);
    const core = (adapter.terminal as unknown as {
      _core: { coreService: { triggerDataEvent(data: string, user?: boolean): void } };
    })._core;
    try {
      await new Promise<void>((resolve) => adapter.terminal.write('hello\x1b[6n\x1b[c\x1b[>c\x1b[?1006$p\x1bP$qm\x1b\\', resolve));
      expect(listener).not.toHaveBeenCalled();
      adapter.terminal.input('中文\r');
      core.coreService.triggerDataEvent('\x1b[<0;10;5M', true);
      core.coreService.triggerDataEvent('\x1b[I');
      core.coreService.triggerDataEvent('\x1b[O');
      expect(listener.mock.calls).toEqual([
        ['中文\r', 'utf8'], ['\x1b[<0;10;5M', 'utf8'], ['\x1b[I', 'utf8'], ['\x1b[O', 'utf8'],
      ]);
    } finally { subscription.dispose(); adapter.dispose(); }
  });

  it('forwards text and legacy mouse bytes separately and disposes both listeners', () => {
    const adapter = new BrowserXtermAdapter({
      fontFamily: 'monospace', fontSize: 13, lineHeight: 1.2,
      themeId: undefined, renderer: 'dom', windowsBuild: null, openLink: () => undefined,
    });
    const listener = vi.fn();
    const subscription = adapter.onInput(listener);
    // Exercise xterm's actual input emitters, including bytes that are not UTF-8.
    const core = (adapter.terminal as unknown as {
      _core: { coreService: { triggerBinaryEvent(data: string): void } };
    })._core;
    const mouse = '\x1b[M \xc8\xff';
    try {
      adapter.terminal.input('中文\r');
      core.coreService.triggerBinaryEvent(mouse);
      expect(listener.mock.calls).toEqual([['中文\r', 'utf8'], [mouse, 'binary']]);
      subscription.dispose();
      adapter.terminal.input('ignored');
      core.coreService.triggerBinaryEvent(mouse);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      subscription.dispose();
      adapter.dispose();
    }
  });
});
