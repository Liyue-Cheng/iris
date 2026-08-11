import { describe, expect, it } from 'vitest';
import type { AppBuildType } from '@shared/types';
import {
  buildAppInfo,
  externalLink,
  legalDocumentPath,
  type AppInfoRuntime,
} from './app-info';

const manifest = {
  productName: 'Iris',
  version: '0.1.0-beta.5',
  author: { name: '程璃月' },
  copyright: 'Copyright (c) 2026 程璃月',
  homepage: 'https://github.com/Liyue-Cheng/iris#readme',
  repository: { type: 'git', url: 'git+https://github.com/Liyue-Cheng/iris.git' },
  bugs: { url: 'https://github.com/Liyue-Cheng/iris/issues' },
  license: 'MIT',
};

function runtime(buildType: AppBuildType = 'dev'): AppInfoRuntime {
  return {
    version: '0.1.0-beta.5',
    buildType,
    platform: 'win32',
    arch: 'x64',
    electronVersion: '31.0.2',
    chromiumVersion: '126.0.6478.36',
    nodeVersion: '20.14.0',
    userDataPath: 'C:\\Users\\someone\\AppData\\Roaming\\Iris',
  };
}

describe('buildAppInfo', () => {
  it.each<AppBuildType>(['dev', 'portable', 'installed'])(
    'assembles trusted %s runtime facts and normalized links',
    (buildType) => {
      const result = buildAppInfo(runtime(buildType), manifest);
      expect(result).toMatchObject({
        name: 'Iris',
        version: '0.1.0-beta.5',
        buildType,
        license: 'MIT',
        copyright: 'Copyright (c) 2026 程璃月',
        links: {
          source: 'https://github.com/Liyue-Cheng/iris',
          releases: 'https://github.com/Liyue-Cheng/iris/releases',
          issues: 'https://github.com/Liyue-Cheng/iris/issues',
        },
      });
    },
  );

  it('rejects version, license, copyright, and URL drift', () => {
    expect(() => buildAppInfo({ ...runtime(), version: '0.1.0' }, manifest)).toThrow(
      'does not match',
    );
    expect(() => buildAppInfo(runtime(), { ...manifest, license: 'AGPL-3.0' })).toThrow(
      'unsupported product license',
    );
    expect(() => buildAppInfo(runtime(), { ...manifest, copyright: 'Copyright 2026' })).toThrow(
      'must include author.name',
    );
    expect(() =>
      buildAppInfo(runtime(), {
        ...manifest,
        repository: { type: 'git', url: 'http://example.com/iris.git' },
      }),
    ).toThrow('must use HTTPS');
  });
});

describe('About actions', () => {
  const info = buildAppInfo(runtime(), manifest);

  it('accepts only predefined external link ids', () => {
    expect(externalLink(info, 'releases')).toBe(
      'https://github.com/Liyue-Cheng/iris/releases',
    );
    expect(() => externalLink(info, 'https://example.com')).toThrow('unsupported link id');
  });

  it('resolves legal files from the app root in dev and resources when packaged', () => {
    expect(
      legalDocumentPath(
        { appPath: 'C:\\repo', resourcesPath: 'C:\\resources', packaged: false },
        'license',
      ),
    ).toBe('C:\\repo\\LICENSE');
    expect(
      legalDocumentPath(
        { appPath: 'C:\\resources\\app.asar', resourcesPath: 'C:\\resources', packaged: true },
        'license',
      ),
    ).toBe('C:\\resources\\LICENSE.txt');
    expect(
      legalDocumentPath(
        { appPath: 'C:\\resources\\app.asar', resourcesPath: 'C:\\resources', packaged: true },
        'thirdPartyNotices',
      ),
    ).toBe('C:\\resources\\THIRD_PARTY_NOTICES.txt');
    expect(() =>
      legalDocumentPath(
        { appPath: 'C:\\repo', resourcesPath: 'C:\\resources', packaged: false },
        'arbitrary',
      ),
    ).toThrow('unsupported document id');
  });
});
