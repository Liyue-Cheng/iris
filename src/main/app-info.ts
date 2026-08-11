import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AppBuildType,
  AppInfo,
} from '@shared/types';

interface ProductManifest {
  productName?: unknown;
  version?: unknown;
  author?: unknown;
  copyright?: unknown;
  homepage?: unknown;
  repository?: unknown;
  bugs?: unknown;
  license?: unknown;
}

export interface AppInfoRuntime {
  version: string;
  buildType: AppBuildType;
  platform: string;
  arch: string;
  electronVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  userDataPath: string;
}

export interface LegalDocumentRuntime {
  appPath: string;
  resourcesPath: string;
  packaged: boolean;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`[app:info] package.json ${field} must be a non-empty string`);
  }
  return value.trim();
}

function authorName(author: unknown): string {
  if (typeof author === 'string') return requiredString(author, 'author');
  if (author && typeof author === 'object' && 'name' in author) {
    return requiredString(author.name, 'author.name');
  }
  throw new Error('[app:info] package.json author must name the copyright holder');
}

function packageUrl(value: unknown, field: string): string {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'url' in value
        ? value.url
        : null;
  return requiredString(raw, field);
}

function httpsUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`[app:info] package.json ${field} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`[app:info] package.json ${field} must use HTTPS`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function repositoryUrl(repository: unknown): string {
  const raw = packageUrl(repository, 'repository');
  const normalized = raw.replace(/^git\+/, '').replace(/\.git$/, '');
  return httpsUrl(normalized, 'repository');
}

export function readProductManifest(appPath: string): ProductManifest {
  const manifestPath = join(appPath, 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`[app:info] unable to read ${manifestPath}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('[app:info] package.json must contain an object');
  }
  return parsed as ProductManifest;
}

export function buildAppInfo(runtime: AppInfoRuntime, manifest: ProductManifest): AppInfo {
  const name = requiredString(manifest.productName, 'productName');
  const manifestVersion = requiredString(manifest.version, 'version');
  if (manifestVersion !== runtime.version) {
    throw new Error(
      `[app:info] runtime version ${runtime.version} does not match package.json ${manifestVersion}`,
    );
  }

  const license = requiredString(manifest.license, 'license');
  if (license !== 'MIT') {
    throw new Error(`[app:info] unsupported product license ${license}`);
  }

  const holder = authorName(manifest.author);
  const copyright = requiredString(manifest.copyright, 'copyright');
  if (!copyright.includes(holder)) {
    throw new Error('[app:info] copyright must include author.name');
  }

  httpsUrl(requiredString(manifest.homepage, 'homepage'), 'homepage');
  const source = repositoryUrl(manifest.repository);
  const issues = httpsUrl(packageUrl(manifest.bugs, 'bugs'), 'bugs');

  return {
    name,
    version: runtime.version,
    buildType: runtime.buildType,
    platform: requiredString(runtime.platform, 'runtime platform'),
    arch: requiredString(runtime.arch, 'runtime arch'),
    electronVersion: requiredString(runtime.electronVersion, 'runtime Electron version'),
    chromiumVersion: requiredString(runtime.chromiumVersion, 'runtime Chromium version'),
    nodeVersion: requiredString(runtime.nodeVersion, 'runtime Node version'),
    userDataPath: requiredString(runtime.userDataPath, 'runtime userData path'),
    license: 'MIT',
    copyright,
    links: {
      source,
      releases: `${source}/releases`,
      issues,
    },
  };
}

export function externalLink(info: AppInfo, id: unknown): string {
  switch (id) {
    case 'source':
    case 'releases':
    case 'issues':
      return info.links[id];
    default:
      throw new Error(`[app:open-external-link] unsupported link id ${String(id)}`);
  }
}

export function externalUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('[shell:open-external-url] URL must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('[shell:open-external-url] invalid URL');
  }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    throw new Error(`[shell:open-external-url] unsupported protocol ${parsed.protocol}`);
  }
  return parsed.toString();
}

export function legalDocumentPath(
  runtime: LegalDocumentRuntime,
  id: unknown,
): string {
  const filename = (() => {
    switch (id) {
      case 'license':
        return runtime.packaged ? 'LICENSE.txt' : 'LICENSE';
      case 'thirdPartyNotices':
        return 'THIRD_PARTY_NOTICES.txt';
      default:
        throw new Error(`[app:open-legal-document] unsupported document id ${String(id)}`);
    }
  })();
  return join(runtime.packaged ? runtime.resourcesPath : runtime.appPath, filename);
}
