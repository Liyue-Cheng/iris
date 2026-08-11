import type { AppBuildType, AppInfo } from '@shared/types';

export const APP_BUILD_TYPE_KEYS: Record<
  AppBuildType,
  'settings.aboutBuildDev' | 'settings.aboutBuildPortable' | 'settings.aboutBuildInstalled'
> = {
  dev: 'settings.aboutBuildDev',
  portable: 'settings.aboutBuildPortable',
  installed: 'settings.aboutBuildInstalled',
};

export function formatAppPlatform(platform: string, arch: string): string {
  const platformName: Record<string, string> = {
    win32: 'Windows',
    darwin: 'macOS',
    linux: 'Linux',
  };
  return `${platformName[platform] ?? platform} ${arch}`;
}

/** Privacy-conscious diagnostics: intentionally excludes all filesystem paths. */
export function appDiagnostics(info: AppInfo): string {
  return [
    'Iris diagnostics',
    `Version: ${info.version}`,
    `Build: ${info.buildType}`,
    `Platform: ${formatAppPlatform(info.platform, info.arch)}`,
    `Electron: ${info.electronVersion}`,
    `Chromium: ${info.chromiumVersion}`,
    `Node.js: ${info.nodeVersion}`,
  ].join('\n');
}
