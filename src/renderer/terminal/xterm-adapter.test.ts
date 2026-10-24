// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { BrowserXtermAdapter } from './xterm-adapter';

// These tests exercise input, not canvas rendering. xterm probes canvas at import.
vi.hoisted(() => { HTMLCanvasElement.prototype.getContext = () => null; });

describe('BrowserXtermAdapter input', () => {
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
