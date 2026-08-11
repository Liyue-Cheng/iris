#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const readText = (path) => readFileSync(resolve(root, path), 'utf8');
const readJson = (path) => JSON.parse(readText(path));
const errors = [];
const check = (condition, message) => {
  if (!condition) errors.push(message);
};

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const builder = loadYaml(readText('electron-builder.yml'));
const license = readText('LICENSE');
const settingsView = readText('src/renderer/components/settings/SettingsView.tsx');
const i18n = readText('src/shared/i18n/resources.ts');

const expected = {
  productName: 'Iris',
  license: 'MIT',
  author: '程璃月',
  copyright: 'Copyright (c) 2026 程璃月',
  homepage: 'https://github.com/Liyue-Cheng/iris#readme',
  repository: 'git+https://github.com/Liyue-Cheng/iris.git',
  issues: 'https://github.com/Liyue-Cheng/iris/issues',
};

check(packageJson.productName === expected.productName, 'package.json productName must be Iris');
check(packageJson.license === expected.license, 'package.json license must be MIT');
check(packageJson.author?.name === expected.author, 'package.json author.name is not canonical');
check(packageJson.copyright === expected.copyright, 'package.json copyright is not canonical');
check(packageJson.homepage === expected.homepage, 'package.json homepage is not canonical');
check(packageJson.repository?.url === expected.repository, 'package.json repository is not canonical');
check(packageJson.bugs?.url === expected.issues, 'package.json bugs URL is not canonical');
check(packageLock.version === packageJson.version, 'package-lock root version differs from package.json');
check(
  packageLock.packages?.['']?.version === packageJson.version,
  'package-lock package version differs from package.json',
);

check(builder?.productName === undefined, 'electron-builder.yml must not override productName');
check(builder?.copyright === expected.copyright, 'electron-builder copyright is not canonical');
check(builder?.nsis?.license === 'LICENSE', 'NSIS must display the root LICENSE');
const resources = Array.isArray(builder?.extraResources) ? builder.extraResources : [];
check(
  resources.some((entry) => entry?.from === 'LICENSE' && entry?.to === 'LICENSE.txt'),
  'LICENSE must be packaged as LICENSE.txt',
);
check(
  resources.some(
    (entry) =>
      entry?.from === 'THIRD_PARTY_NOTICES.txt' && entry?.to === 'THIRD_PARTY_NOTICES.txt',
  ),
  'THIRD_PARTY_NOTICES.txt must be packaged',
);

check(license.startsWith('MIT License'), 'LICENSE must contain the MIT license');
check(license.includes(expected.author), 'LICENSE copyright holder is not canonical');
check(existsSync(resolve(root, 'THIRD_PARTY_NOTICES.txt')), 'THIRD_PARTY_NOTICES.txt is missing');

const staleLiterals = [
  'AGPL-3.0',
  'Version, build type, and data-directory details are pending IPC support.',
  '版本号、构建形态和数据目录信息等待 IPC 支持。',
  'No version metadata',
  '无版本元数据',
];
for (const literal of staleLiterals) {
  check(
    !settingsView.includes(literal) && !i18n.includes(literal),
    `stale About literal remains in renderer sources: ${literal}`,
  );
}
check(
  !new RegExp(`['\"]v?${packageJson.version.replaceAll('.', '\\.')}['\"]`).test(settingsView),
  'AboutPanel must not hard-code the package version',
);

if (errors.length > 0) {
  console.error('Product metadata check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Product metadata is consistent for Iris ${packageJson.version}.`);
}
