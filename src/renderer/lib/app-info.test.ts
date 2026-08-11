import { describe, expect, it } from 'vitest';
import type { AppInfo } from '@shared/types';
import { APP_BUILD_TYPE_KEYS, appDiagnostics, formatAppPlatform } from './app-info';

const info: AppInfo = {
  name: 'Iris',
  version: '0.1.0-beta.5',
  buildType: 'portable',
  platform: 'win32',
  arch: 'x64',
  electronVersion: '31.0.2',
  chromiumVersion: '126.0.6478.36',
  nodeVersion: '20.14.0',
  userDataPath: 'C:\\Users\\private-name\\AppData\\Roaming\\Iris',
  license: 'MIT',
  copyright: 'Copyright (c) 2026 程璃月',
  links: {
    source: 'https://github.com/Liyue-Cheng/iris',
    releases: 'https://github.com/Liyue-Cheng/iris/releases',
    issues: 'https://github.com/Liyue-Cheng/iris/issues',
  },
};

describe('About renderer helpers', () => {
  it('maps every build type to a localized catalog key', () => {
    expect(APP_BUILD_TYPE_KEYS).toEqual({
      dev: 'settings.aboutBuildDev',
      portable: 'settings.aboutBuildPortable',
      installed: 'settings.aboutBuildInstalled',
    });
  });

  it('formats supported and unknown platforms without losing architecture', () => {
    expect(formatAppPlatform('win32', 'x64')).toBe('Windows x64');
    expect(formatAppPlatform('freebsd', 'arm64')).toBe('freebsd arm64');
  });

  it('copies useful diagnostics without filesystem or project data', () => {
    const diagnostics = appDiagnostics(info);
    expect(diagnostics).toContain('Version: 0.1.0-beta.5');
    expect(diagnostics).toContain('Build: portable');
    expect(diagnostics).toContain('Platform: Windows x64');
    expect(diagnostics).toContain('Electron: 31.0.2');
    expect(diagnostics).not.toContain(info.userDataPath);
    expect(diagnostics).not.toContain('private-name');
  });
});
