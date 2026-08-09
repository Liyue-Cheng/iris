#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, 'THIRD_PARTY_NOTICES.txt');
const packageJson = readJson(resolve(root, 'package.json'));
const lockfile = readJson(resolve(root, 'package-lock.json'));

// These packages contribute generated code or styles without appearing in a
// TypeScript import. Keep the list small and document why each entry ships.
const additionalDistributedRoots = ['tailwindcss-animate'];

// A few npm tarballs declare MIT but omit the license file. Prefer a license
// from the same installed monorepo; otherwise preserve the package author's
// attribution from package.json/README in a canonical MIT notice.
const licenseTextOverrides = {
  '@xterm/addon-serialize': { from: 'node_modules/@xterm/xterm/LICENSE' },
  '@xterm/headless': { from: 'node_modules/@xterm/xterm/LICENSE' },
  'react-remove-scroll-bar': { from: 'node_modules/react-remove-scroll/LICENSE' },
  'remark-math': { from: 'node_modules/remark/license' },
  dlv: { copyright: 'Copyright (c) Jason Miller' },
  keyv: { copyright: 'Copyright (c) Jared Wray' },
};

// Explicitly select one branch of dual licenses and repair known incomplete
// package metadata. The selected file must still be present in the tarball.
const licenseIdentifierOverrides = {
  dompurify: 'Apache-2.0',
  khroma: 'MIT',
};
const licenseFileSelections = {
  dompurify: ['LICENSE'],
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else files.push(path);
  }
  return files;
}

function packageName(specifier) {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    specifier.startsWith('@main/') ||
    specifier.startsWith('@renderer/') ||
    specifier.startsWith('@shared/')
  ) {
    return null;
  }
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function collectSourceImports() {
  const names = new Set();
  const sourceFiles = walkFiles(resolve(root, 'src')).filter(
    (path) => /\.tsx?$/i.test(path) && !/\.(test|spec)\.tsx?$/i.test(path),
  );

  for (const path of sourceFiles) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      false,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node) => {
      let specifier = null;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifier = node.moduleSpecifier.text;
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        specifier = node.arguments[0].text;
      }

      if (specifier) {
        const name = packageName(specifier);
        if (name) names.add(name);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
}

function resolveDependency(fromPath, dependency) {
  let base = fromPath;
  while (true) {
    const candidate = base
      ? `${base}/node_modules/${dependency}`
      : `node_modules/${dependency}`;
    if (lockfile.packages[candidate]) return candidate;
    if (!base) return null;
    const nestedAt = base.lastIndexOf('/node_modules/');
    base = nestedAt === -1 ? '' : base.slice(0, nestedAt);
  }
}

function collectDependencyClosure(rootNames) {
  const paths = new Set();
  const queue = [...rootNames].map((name) => {
    const path = resolveDependency('', name);
    if (!path) throw new Error(`Dependency ${name} is imported by the app but absent from lockfile`);
    return path;
  });

  while (queue.length) {
    const path = queue.shift();
    if (paths.has(path)) continue;
    paths.add(path);
    const entry = lockfile.packages[path];
    const peerMeta = entry.peerDependenciesMeta ?? {};
    const dependencies = {
      ...(entry.dependencies ?? {}),
      ...(entry.optionalDependencies ?? {}),
      ...Object.fromEntries(
        Object.entries(entry.peerDependencies ?? {}).filter(
          ([name]) => !peerMeta[name]?.optional,
        ),
      ),
    };
    for (const name of Object.keys(dependencies)) {
      const resolved = resolveDependency(path, name);
      if (resolved && existsSync(resolve(root, resolved, 'package.json'))) queue.push(resolved);
    }
  }
  return paths;
}

function licenseFiles(packageDirectory) {
  return readdirSync(packageDirectory)
    .filter((name) => /^(licen[cs]e|copying|copyright|notice)(?:$|[._-])/i.test(name))
    .filter((name) => statSync(join(packageDirectory, name)).isFile())
    .sort((a, b) => a.localeCompare(b));
}

function normalizeText(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
}

function mitLicense(copyright) {
  return `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

function packageLicenseTexts(metadata, directory) {
  const files = licenseFileSelections[metadata.name] ?? licenseFiles(directory);
  if (files.length) {
    return files.map((name) => ({
      name,
      text: normalizeText(readFileSync(resolve(directory, name), 'utf8')),
    }));
  }

  const override = licenseTextOverrides[metadata.name];
  if (!override || metadata.license !== 'MIT') return null;
  if (override.from) {
    return [
      {
        name: `MIT license from ${override.from}`,
        text: normalizeText(readFileSync(resolve(root, override.from), 'utf8')),
      },
    ];
  }
  return [{ name: 'MIT license reconstructed from package attribution', text: mitLicense(override.copyright) }];
}

function renderNotices(packagePaths) {
  const packages = new Map();
  const missingTexts = [];

  for (const lockPath of [...packagePaths].sort()) {
    const directory = resolve(root, lockPath);
    if (!existsSync(resolve(directory, 'package.json'))) continue;
    const metadata = readJson(resolve(directory, 'package.json'));
    const key = `${metadata.name}@${metadata.version}`;
    if (packages.has(key)) continue;
    const texts = packageLicenseTexts(metadata, directory);
    if (!texts) {
      missingTexts.push(`${key} (${metadata.license ?? 'unknown license'})`);
      continue;
    }
    const license =
      licenseIdentifierOverrides[metadata.name] ??
      metadata.license ??
      lockfile.packages[lockPath].license;
    if (!license) {
      missingTexts.push(`${key} (unknown license identifier)`);
      continue;
    }
    packages.set(key, {
      name: metadata.name,
      version: metadata.version,
      license,
      repository:
        typeof metadata.repository === 'string'
          ? metadata.repository
          : metadata.repository?.url ?? metadata.homepage ?? '',
      texts,
    });
  }

  if (missingTexts.length) {
    throw new Error(
      `Distributed packages without license text:\n${missingTexts.map((item) => `  - ${item}`).join('\n')}`,
    );
  }

  const lines = [
    'IRIS THIRD-PARTY SOFTWARE NOTICES',
    '=================================',
    '',
    'This file is generated by scripts/generate-third-party-notices.mjs.',
    'It covers npm packages distributed with Iris or bundled into its renderer.',
    'Do not edit it manually.',
    '',
    `Package count: ${packages.size}`,
    '',
  ];

  for (const item of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push('------------------------------------------------------------------------', '');
    lines.push(`${item.name}@${item.version}`);
    lines.push(`License: ${item.license}`);
    if (item.repository) lines.push(`Source: ${item.repository}`);
    for (const file of item.texts) {
      lines.push('', `[${file.name}]`, '', file.text);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

const declaredDependencies = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
]);
const roots = collectSourceImports();
for (const name of Object.keys(packageJson.dependencies ?? {})) roots.add(name);
for (const name of additionalDistributedRoots) roots.add(name);
for (const name of roots) {
  if (!declaredDependencies.has(name)) {
    throw new Error(`Source import ${name} is not declared in package.json`);
  }
}

const notices = renderNotices(collectDependencyClosure(roots));
if (process.argv.includes('--check')) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  if (normalizeText(current) !== normalizeText(notices)) {
    console.error(
      `[licenses] ${relative(root, outputPath)} is missing or stale; run npm run licenses:generate`,
    );
    process.exit(1);
  }
  console.log(`[licenses] ${relative(root, outputPath)} is current`);
} else {
  writeFileSync(outputPath, notices, 'utf8');
  console.log(`[licenses] wrote ${relative(root, outputPath)}`);
}
