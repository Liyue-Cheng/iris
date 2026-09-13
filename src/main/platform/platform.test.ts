import { describe, expect, it } from 'vitest';
import { createPlatformServices } from './index';
import { createShellService } from './shell';
import { createWindowChromeService } from './window-chrome';

describe('platform services', () => {
  it('selects native shells and command argument conventions', () => {
    const win = createShellService('win32').resolve({ PATH: '' });
    expect(win.kind).toBe('powershell');
    expect(createShellService('win32').commandArgs(win, 'echo ok')).toContain('echo ok');

    const posix = createShellService('linux').resolve({ SHELL: '/bin/sh' });
    expect(posix.kind).toBe('posix');
    expect(createShellService('linux').commandArgs(posix, 'echo ok')).toEqual(['-lc', 'echo ok']);
  });

  it('exposes platform capabilities without leaking implementation commands', () => {
    const services = createPlatformServices('darwin');
    expect(services.capabilities).toMatchObject({ platform: 'darwin', supportsConpty: false, windowChrome: 'macos-native' });
    expect(services.capabilities.shell.executable).not.toContain('powershell');
  });

  it('uses native macOS window behavior and keeps the app alive after the last window closes', () => {
    const chrome = createWindowChromeService('darwin');
    expect(chrome.shouldQuitWhenLastWindowCloses()).toBe(false);
    expect(chrome.options()).toMatchObject({ titleBarStyle: 'hiddenInset' });
  });
});
