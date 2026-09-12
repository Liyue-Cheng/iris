/**
 * Managed document assets. A document owns exactly one sibling directory:
 * `<document-name>.assets/`. Markdown links and disk files are the index;
 * there is deliberately no manifest or hidden database.
 */
import { promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { remark } from 'remark';
import type {
  AssociatedPathEntry,
  AssetEntry,
  AssetImportPayload,
  AssetImportResult,
  AssetInventory,
  AssetKind,
} from '@shared/types';
import { mainT } from './i18n';
import { writeFileAtomic } from './atomic-write';
export const ASSOCIATED_PATHS_FILE = 'links.txt';

interface MarkdownNode {
  type?: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

interface AssetReference {
  source: string;
  kind: AssetKind;
  target: string | null;
}

interface DetectedFile {
  kind: AssetKind;
  mimeType: string;
  extension: string;
}

export class AssetError extends Error {
  constructor(
    public readonly code:
      | 'InvalidPayload'
      | 'ReadFailed'
      | 'WriteFailed'
      | 'UnsupportedType'
      | 'TooLarge'
      | 'Referenced',
    message: string,
  ) {
    super(`[AssetManager] ${code}: ${message}`);
    this.name = 'AssetError';
  }
}

export class AssetManager {
  async list(projectRoot: string, docPath: string): Promise<AssetInventory> {
    const doc = await this.requireDocument(projectRoot, docPath);
    const directoryPath = companionPath(docPath);
    const directoryAbs = resolveInside(projectRoot, directoryPath);
    await requireSafeDirectoryIfPresent(projectRoot, directoryAbs);

    let raw: string;
    try {
      raw = await fs.readFile(doc.abs, 'utf8');
    } catch (err) {
      throw new AssetError('ReadFailed', messageFor(mainT('error.assetRead', { path: docPath }), err));
    }

    const references = collectReferences(projectRoot, docPath, raw);
    const referenceMap = new Map<string, AssetReference[]>();
    for (const ref of references) {
      if (!ref.target) continue;
      const current = referenceMap.get(normalize(ref.target)) ?? [];
      current.push(ref);
      referenceMap.set(normalize(ref.target), current);
    }

    const assets: AssetEntry[] = [];
    const physicalPaths = new Set<string>();
    try {
      const entries = await fs.readdir(directoryAbs, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ASSOCIATED_PATHS_FILE) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const abs = join(directoryAbs, entry.name);
        const key = normalize(abs);
        physicalPaths.add(key);
        const refs = referenceMap.get(key) ?? [];
        const stat = await fs.stat(abs);
        const detected = detectStoredFile(entry.name);
        assets.push({
          path: toProjectPath(projectRoot, abs),
          markdownUrl: refs[0]?.source ?? markdownUrlFor(docPath, toProjectPath(projectRoot, abs)),
          name: entry.name,
          kind: detected.kind,
          mimeType: detected.mimeType,
          size: stat.size,
          referenceCount: refs.length,
          exists: true,
        });
      }
    } catch (err) {
      if (!isNotFound(err)) {
        throw new AssetError(
          'ReadFailed',
          messageFor(mainT('error.assetList', { path: directoryPath }), err),
        );
      }
    }

    for (const [target, refs] of referenceMap) {
      if (physicalPaths.has(target)) continue;
      const first = refs[0];
      if (!first) continue;
      const managed = isInside(directoryAbs, target);
      if (!managed) continue;
      let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
      try {
        stat = await fs.stat(target);
      } catch {
        stat = null;
      }
      const detected = detectStoredFile(basename(target));
      assets.push({
        path: toProjectPath(projectRoot, target),
        markdownUrl: first.source,
        name: basename(target),
        kind: first.kind === 'image' ? 'image' : detected.kind,
        mimeType: detected.mimeType,
        size: stat?.isFile() ? stat.size : null,
        referenceCount: refs.length,
        exists: Boolean(stat?.isFile()),
      });
    }

    assets.sort((a, b) => a.name.localeCompare(b.name));
    const associated = await this.readAssociated(projectRoot, directoryAbs);
    return {
      docPath,
      directoryPath,
      assets,
      associated,
    };
  }

  async addAssociated(projectRoot: string, docPath: string, targetPath: string): Promise<AssociatedPathEntry> {
    await this.requireDocument(projectRoot, docPath);
    const raw = (targetPath ?? '').trim();
    if (!raw || /[\r\n\u0000]/.test(raw)) {
      throw new AssetError('InvalidPayload', mainT('error.assetAssociationInvalid'));
    }
    const absolute = resolveAssociatedPath(projectRoot, raw);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat || (!stat.isFile() && !stat.isDirectory())) {
      throw new AssetError('InvalidPayload', mainT('error.assetAssociationMissing', { path: raw }));
    }
    const directoryAbs = resolveInside(projectRoot, companionPath(docPath));
    await requireSafeDirectoryIfPresent(projectRoot, directoryAbs);
    await fs.mkdir(directoryAbs, { recursive: true });
    const stored = storeAssociatedPath(projectRoot, absolute);
    const current = await readAssociatedLines(directoryAbs);
    if (!current.some((line) => normalize(resolveAssociatedPath(projectRoot, line)) === normalize(absolute))) {
      await writeFileAtomic(join(directoryAbs, ASSOCIATED_PATHS_FILE), `${[...current, stored].join('\n')}\n`);
    }
    return associatedEntry(stored, absolute, stat);
  }

  async removeAssociated(projectRoot: string, docPath: string, targetPath: string): Promise<void> {
    await this.requireDocument(projectRoot, docPath);
    const directoryAbs = resolveInside(projectRoot, companionPath(docPath));
    await requireSafeDirectoryIfPresent(projectRoot, directoryAbs);
    const current = await readAssociatedLines(directoryAbs);
    const target = normalize(resolveAssociatedPath(projectRoot, targetPath ?? ''));
    const next = current.filter((line) => normalize(resolveAssociatedPath(projectRoot, line)) !== target);
    if (next.length === current.length) {
      throw new AssetError('InvalidPayload', mainT('error.assetAssociationNotFound', { path: targetPath }));
    }
    const links = join(directoryAbs, ASSOCIATED_PATHS_FILE);
    if (next.length === 0) await fs.rm(links, { force: true });
    else await writeFileAtomic(links, `${next.join('\n')}\n`);
  }

  async resolveAssociated(projectRoot: string, docPath: string, targetPath: string): Promise<string> {
    await this.requireDocument(projectRoot, docPath);
    const directoryAbs = resolveInside(projectRoot, companionPath(docPath));
    const current = await readAssociatedLines(directoryAbs);
    const target = normalize(resolveAssociatedPath(projectRoot, targetPath ?? ''));
    const stored = current.find((line) => normalize(resolveAssociatedPath(projectRoot, line)) === target);
    if (!stored) throw new AssetError('InvalidPayload', mainT('error.assetAssociationNotFound', { path: targetPath }));
    return resolveAssociatedPath(projectRoot, stored);
  }

  private async readAssociated(projectRoot: string, directoryAbs: string): Promise<AssociatedPathEntry[]> {
    const lines = await readAssociatedLines(directoryAbs);
    const entries: AssociatedPathEntry[] = [];
    const seen = new Set<string>();
    for (const stored of lines) {
      const absolute = resolveAssociatedPath(projectRoot, stored);
      const key = normalize(absolute);
      if (seen.has(key)) continue;
      seen.add(key);
      const stat = await fs.stat(absolute).catch(() => null);
      entries.push(associatedEntry(stored, absolute, stat));
    }
    return entries;
  }

  async import(
    projectRoot: string,
    payload: AssetImportPayload,
  ): Promise<AssetImportResult> {
    await this.requireDocument(projectRoot, payload.docPath);
    if (!payload.name || !payload.bytes || typeof payload.mimeType !== 'string') {
      throw new AssetError('InvalidPayload', mainT('error.assetPayloadRequired'));
    }
    const bytes = Buffer.from(payload.bytes);
    const detected = detectImportedFile(payload.name, payload.mimeType);

    const directoryPath = companionPath(payload.docPath);
    const directoryAbs = resolveInside(projectRoot, directoryPath);
    const directoryExisted = await pathExists(directoryAbs);
    await requireSafeDirectoryIfPresent(projectRoot, directoryAbs);
    await fs.mkdir(directoryAbs, { recursive: true });

    const stem = sanitizeStem(payload.name);
    const target = await allocateUniqueName(directoryAbs, stem, detected.extension);

    try {
      await writeFileAtomic(target, bytes);
    } catch (err) {
      if (!directoryExisted) await fs.rmdir(directoryAbs).catch(() => {});
      throw new AssetError(
        'WriteFailed',
        messageFor(mainT('error.assetWrite', { name: payload.name }), err),
      );
    }

    const path = toProjectPath(projectRoot, target);
    return {
      path,
      markdownUrl: markdownUrlFor(payload.docPath, path),
      name: basename(target),
      kind: detected.kind,
      mimeType: detected.mimeType,
      size: bytes.length,
    };
  }

  async managedFileCount(projectRoot: string, docPath: string): Promise<number> {
    const inventory = await this.list(projectRoot, docPath);
    return inventory.assets.filter((asset) => asset.path !== '').length;
  }

  companionPath(docPath: string): string {
    return companionPath(docPath);
  }

  private async requireDocument(
    projectRoot: string,
    docPath: string,
  ): Promise<{ abs: string }> {
    const portable = docPath.replace(/\\/g, '/');
    if (!portable.startsWith('.iris/') || !portable.toLowerCase().endsWith('.md')) {
      throw new AssetError('InvalidPayload', mainT('error.assetNotIrisDocument', { path: docPath }));
    }
    const abs = resolveInside(projectRoot, docPath);
    const stat = await fs.lstat(abs).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new AssetError('InvalidPayload', mainT('error.assetDocumentNotFile', { path: docPath }));
    }
    const real = await fs.realpath(abs).catch(() => null);
    if (!real) throw new AssetError('ReadFailed', mainT('error.assetDocumentResolve', { path: docPath }));
    resolveInside(projectRoot, real);
    return { abs };
  }
}

function companionPath(docPath: string): string {
  return join(dirname(docPath), `${basename(docPath, extname(docPath))}.assets`).split(sep).join('/');
}

async function readAssociatedLines(directoryAbs: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(join(directoryAbs, ASSOCIATED_PATHS_FILE), 'utf8');
    return raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  } catch (err) {
    if (isNotFound(err)) return [];
    throw new AssetError('ReadFailed', messageFor(mainT('error.assetList', { path: ASSOCIATED_PATHS_FILE }), err));
  }
}

function resolveAssociatedPath(projectRoot: string, stored: string): string {
  return normalize(isAbsolute(stored) ? stored : resolve(projectRoot, stored));
}

function storeAssociatedPath(projectRoot: string, absolute: string): string {
  const rel = relative(projectRoot, absolute);
  if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    return rel.split(sep).join('/');
  }
  return absolute;
}

function associatedEntry(
  stored: string,
  absolute: string,
  stat: Awaited<ReturnType<typeof fs.stat>> | null,
): AssociatedPathEntry {
  return {
    path: stored,
    name: basename(absolute),
    kind: stat?.isDirectory() ? 'directory' : stat?.isFile() ? 'file' : null,
    exists: Boolean(stat?.isDirectory() || stat?.isFile()),
    size: stat?.isFile() && typeof stat.size === 'number' ? stat.size : null,
  };
}

function collectReferences(projectRoot: string, docPath: string, markdown: string): AssetReference[] {
  let tree: MarkdownNode;
  try {
    tree = remark().parse(markdown) as MarkdownNode;
  } catch {
    return [];
  }
  const definitions = new Map<string, string>();
  walk(tree, (node) => {
    if (node.type === 'definition' && node.identifier && node.url) {
      definitions.set(node.identifier.toLowerCase(), node.url);
    }
  });

  const references: AssetReference[] = [];
  walk(tree, (node) => {
    let source: string | undefined;
    let kind: AssetKind = 'attachment';
    if (node.type === 'image') {
      source = node.url;
      kind = 'image';
    } else if (node.type === 'link') {
      source = node.url;
    } else if (node.type === 'imageReference' && node.identifier) {
      source = definitions.get(node.identifier.toLowerCase());
      kind = 'image';
    } else if (node.type === 'linkReference' && node.identifier) {
      source = definitions.get(node.identifier.toLowerCase());
    }
    if (!source) return;
    const target = resolveMarkdownTarget(projectRoot, docPath, source);
    if (target) references.push({ source, kind, target });
  });
  return references;
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  node.children?.forEach((child) => walk(child, visit));
}

function resolveMarkdownTarget(projectRoot: string, docPath: string, source: string): string | null {
  const withoutSuffix = source.split(/[?#]/, 1)[0] ?? '';
  if (!withoutSuffix || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(withoutSuffix)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    return null;
  }
  try {
    return resolveInside(projectRoot, join(dirname(docPath), decoded));
  } catch {
    return null;
  }
}

function detectImportedFile(name: string, declaredMime: string): DetectedFile {
  const stored = detectStoredFile(name);
  return declaredMime ? { ...stored, mimeType: declaredMime } : stored;
}

function detectStoredFile(name: string): DetectedFile {
  const extension = extname(name).toLowerCase();
  const known = new Map<string, string>([
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.avif', 'image/avif'],
    ['.pdf', 'application/pdf'],
    ['.txt', 'text/plain'],
    ['.csv', 'text/csv'],
    ['.json', 'application/json'],
    ['.zip', 'application/zip'],
  ]);
  const mimeType = known.get(extension) ?? 'application/octet-stream';
  const kind: AssetKind = mimeType.startsWith('image/') ? 'image' : 'attachment';
  const safeExtension = /^\.[a-z\d]{1,10}$/.test(extension) ? extension : '.bin';
  return { kind, mimeType, extension: safeExtension };
}

function sanitizeStem(name: string): string {
  const stem = basename(name.replace(/\\/g, '/'), extname(name))
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[-.]+$/g, '')
    .replace(/^[-.]+/g, '')
    .slice(0, 48);
  return stem || 'asset';
}

async function allocateUniqueName(directory: string, stem: string, extension: string): Promise<string> {
  for (let index = 0; index < 10000; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`;
    const candidate = join(directory, `${stem}${suffix}${extension}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new AssetError('WriteFailed', mainT('error.assetUniqueName', { name: stem }));
}

function markdownUrlFor(docPath: string, assetPath: string): string {
  const rel = relative(dirname(docPath), assetPath).split(sep).map(encodeURIComponent).join('/');
  return rel.startsWith('../') ? rel : `./${rel}`;
}

function resolveInside(root: string, relPath: string): string {
  const abs = normalize(resolve(root, relPath));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new AssetError('InvalidPayload', mainT('error.assetPathOutsideProject', { path: relPath }));
  }
  return abs;
}

function toProjectPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
}

async function requireSafeDirectoryIfPresent(projectRoot: string, path: string): Promise<void> {
  const stat = await fs.lstat(path).catch(() => null);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new AssetError('InvalidPayload', mainT('error.assetDirectoryNotRegular', { path }));
  }
  if (stat) resolveInside(projectRoot, await fs.realpath(path));
}

function messageFor(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
