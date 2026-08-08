/**
 * Managed document assets. A document owns exactly one sibling directory:
 * `<document-name>.assets/`. Markdown links and disk files are the index;
 * there is deliberately no manifest or hidden database.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { remark } from 'remark';
import type {
  AssetEntry,
  AssetHealth,
  AssetImportPayload,
  AssetImportResult,
  AssetInventory,
  AssetKind,
} from '@shared/types';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);

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
      throw new AssetError('ReadFailed', messageFor(`cannot read ${docPath}`, err));
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
          health: refs.length > 0 ? 'referenced' : 'orphan',
        });
      }
    } catch (err) {
      if (!isNotFound(err)) {
        throw new AssetError('ReadFailed', messageFor(`cannot list ${directoryPath}`, err));
      }
    }

    for (const [target, refs] of referenceMap) {
      if (physicalPaths.has(target)) continue;
      const first = refs[0];
      if (!first) continue;
      const managed = isInside(directoryAbs, target);
      if (!managed && shouldIgnoreUnmanagedReference(first)) continue;
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
        health: managed ? 'missing' : 'unmanaged',
      });
    }

    const embedded = new Map<string, AssetReference[]>();
    for (const ref of references) {
      if (ref.target || !isSupportedDataImage(ref.source)) continue;
      const current = embedded.get(ref.source) ?? [];
      current.push(ref);
      embedded.set(ref.source, current);
    }
    for (const [source, refs] of embedded) {
      const info = parseDataImage(source);
      if (!info) continue;
      assets.push({
        path: '',
        markdownUrl: source,
        name: `embedded-image${info.extension}`,
        kind: 'image',
        mimeType: info.mimeType,
        size: info.bytes.length,
        referenceCount: refs.length,
        health: 'unmanaged',
      });
    }

    assets.sort((a, b) => healthRank(a.health) - healthRank(b.health) || a.name.localeCompare(b.name));
    return {
      docPath,
      directoryPath,
      assets,
      counts: countHealth(assets),
    };
  }

  async import(
    projectRoot: string,
    payload: AssetImportPayload,
  ): Promise<AssetImportResult> {
    await this.requireDocument(projectRoot, payload.docPath);
    if (!payload.name || !payload.bytes || typeof payload.mimeType !== 'string') {
      throw new AssetError('InvalidPayload', 'docPath, name, mimeType and bytes are required');
    }
    const bytes = Buffer.from(payload.bytes);
    if (bytes.length === 0) throw new AssetError('InvalidPayload', 'asset is empty');

    const detected = detectImportedFile(payload.name, payload.mimeType, bytes);
    const limit = detected.kind === 'image' ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
    if (bytes.length > limit) {
      throw new AssetError(
        'TooLarge',
        `${payload.name} is ${bytes.length} bytes; limit is ${limit} bytes`,
      );
    }

    const directoryPath = companionPath(payload.docPath);
    const directoryAbs = resolveInside(projectRoot, directoryPath);
    const directoryExisted = await pathExists(directoryAbs);
    await requireSafeDirectoryIfPresent(projectRoot, directoryAbs);
    await fs.mkdir(directoryAbs, { recursive: true });

    const hash = createHash('sha256').update(bytes).digest('hex');
    const existing = await findExistingHash(directoryAbs, hash);
    if (existing) {
      const path = toProjectPath(projectRoot, existing);
      return {
        path,
        markdownUrl: markdownUrlFor(payload.docPath, path),
        name: basename(existing),
        kind: detected.kind,
        mimeType: detected.mimeType,
        size: bytes.length,
        reused: true,
      };
    }

    const stem = sanitizeStem(payload.name);
    let target = '';
    for (const hashLength of [12, 16, 24, 32, 64]) {
      target = join(directoryAbs, `${stem}--${hash.slice(0, hashLength)}${detected.extension}`);
      if (!(await pathExists(target))) break;
      target = '';
    }
    if (!target) throw new AssetError('WriteFailed', `cannot allocate a unique name for ${payload.name}`);

    const temp = join(directoryAbs, `.iris-asset-${process.pid}-${Date.now()}.tmp`);
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(temp, 'wx');
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, target);
    } catch (err) {
      await handle?.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
      if (!directoryExisted) await fs.rmdir(directoryAbs).catch(() => {});
      throw new AssetError('WriteFailed', messageFor(`cannot write ${payload.name}`, err));
    }

    const path = toProjectPath(projectRoot, target);
    return {
      path,
      markdownUrl: markdownUrlFor(payload.docPath, path),
      name: basename(target),
      kind: detected.kind,
      mimeType: detected.mimeType,
      size: bytes.length,
      reused: false,
    };
  }

  async trash(
    projectRoot: string,
    docPath: string,
    assetPath: string,
    trashItem: (absolutePath: string) => Promise<void>,
  ): Promise<{ path: string }> {
    await this.requireDocument(projectRoot, docPath);
    const directoryAbs = resolveInside(projectRoot, companionPath(docPath));
    await requireSafeDirectoryIfPresent(projectRoot, directoryAbs);
    const target = resolveInside(projectRoot, assetPath);
    if (dirname(target) !== directoryAbs) {
      throw new AssetError('InvalidPayload', `${assetPath} is not owned by ${docPath}`);
    }
    const inventory = await this.list(projectRoot, docPath);
    const asset = inventory.assets.find((item) => normalize(item.path) === normalize(assetPath));
    if (!asset || asset.health !== 'orphan') {
      throw new AssetError('Referenced', `${assetPath} is still referenced or does not exist`);
    }
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new AssetError('InvalidPayload', `${assetPath} is not a regular asset file`);
    }
    try {
      await trashItem(target);
      await fs.rmdir(directoryAbs).catch(() => {});
      return { path: assetPath };
    } catch (err) {
      throw new AssetError('WriteFailed', messageFor(`cannot trash ${assetPath}`, err));
    }
  }

  async adopt(
    projectRoot: string,
    docPath: string,
    source: string,
  ): Promise<AssetImportResult> {
    const doc = await this.requireDocument(projectRoot, docPath);
    const raw = await fs.readFile(doc.abs, 'utf8');
    let name: string;
    let mimeType: string;
    let bytes: Uint8Array;

    const embedded = parseDataImage(source);
    if (embedded) {
      name = `embedded-image${embedded.extension}`;
      mimeType = embedded.mimeType;
      bytes = embedded.bytes;
    } else {
      const target = resolveMarkdownTarget(projectRoot, docPath, source);
      if (!target) throw new AssetError('InvalidPayload', 'only local or data-image references can be adopted');
      const companion = resolveInside(projectRoot, companionPath(docPath));
      if (isInside(companion, target)) {
        throw new AssetError('InvalidPayload', 'asset is already inside the companion directory');
      }
      const stat = await fs.lstat(target).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw new AssetError('InvalidPayload', 'referenced asset is not a regular file');
      }
      resolveInside(projectRoot, await fs.realpath(target));
      name = basename(target);
      mimeType = detectStoredFile(name).mimeType;
      bytes = await fs.readFile(target);
    }

    const imported = await this.import(projectRoot, { docPath, name, mimeType, bytes });
    const next = rewriteMarkdownUrl(raw, source, imported.markdownUrl);
    const current = await fs.readFile(doc.abs, 'utf8');
    if (current !== raw) {
      throw new AssetError('WriteFailed', `${docPath} changed during asset adoption`);
    }
    const temp = `${doc.abs}.tmp.${process.pid}.${Date.now()}`;
    try {
      await fs.writeFile(temp, next, 'utf8');
      await fs.rename(temp, doc.abs);
    } catch (err) {
      await fs.unlink(temp).catch(() => {});
      throw new AssetError('WriteFailed', messageFor(`cannot update ${docPath}`, err));
    }
    return imported;
  }

  async managedFileCount(projectRoot: string, docPath: string): Promise<number> {
    const inventory = await this.list(projectRoot, docPath);
    return inventory.assets.filter((asset) => asset.health === 'referenced' || asset.health === 'orphan').length;
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
      throw new AssetError('InvalidPayload', `not an Iris Markdown document: ${docPath}`);
    }
    const abs = resolveInside(projectRoot, docPath);
    const stat = await fs.lstat(abs).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new AssetError('InvalidPayload', `document is not a regular file: ${docPath}`);
    }
    const real = await fs.realpath(abs).catch(() => null);
    if (!real) throw new AssetError('ReadFailed', `cannot resolve document: ${docPath}`);
    resolveInside(projectRoot, real);
    return { abs };
  }
}

function companionPath(docPath: string): string {
  return join(dirname(docPath), `${basename(docPath, extname(docPath))}.assets`).split(sep).join('/');
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
    if (target || isSupportedDataImage(source)) references.push({ source, kind, target });
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

function rewriteMarkdownUrl(markdown: string, source: string, replacement: string): string {
  const tree = remark().parse(markdown) as MarkdownNode;
  const spans: Array<{ start: number; end: number }> = [];
  walk(tree, (node) => {
    if (!['image', 'link', 'definition'].includes(node.type ?? '') || node.url !== source) return;
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start === undefined || end === undefined) return;
    const slice = markdown.slice(start, end);
    const local = slice.indexOf(source);
    if (local >= 0) spans.push({ start: start + local, end: start + local + source.length });
  });
  const unique = [...new Map(spans.map((span) => [`${span.start}:${span.end}`, span])).values()];
  if (unique.length === 0) {
    throw new AssetError('InvalidPayload', 'the selected URL is no longer present in the document');
  }
  let next = markdown;
  for (const span of unique.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, span.start) + replacement + next.slice(span.end);
  }
  return next;
}

function isSupportedDataImage(source: string): boolean {
  return /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(source);
}

function parseDataImage(
  source: string,
): { bytes: Uint8Array; mimeType: string; extension: string } | null {
  const match = /^data:image\/(png|jpeg|gif|webp|avif);base64,([a-z\d+/=\s]+)$/i.exec(source);
  if (!match?.[1] || !match[2]) return null;
  const subtype = match[1].toLowerCase();
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  const extension = subtype === 'jpeg' ? '.jpg' : `.${subtype}`;
  return { bytes, mimeType: `image/${subtype}`, extension };
}

function shouldIgnoreUnmanagedReference(reference: AssetReference): boolean {
  if (reference.kind === 'image') return false;
  if (!reference.target) return true;
  return extname(reference.target).toLowerCase() === '.md';
}

function detectImportedFile(name: string, declaredMime: string, bytes: Buffer): DetectedFile {
  const image = detectImage(bytes);
  const extension = extname(name).toLowerCase();
  const claimsImage = declaredMime.toLowerCase().startsWith('image/') || IMAGE_EXTENSIONS.has(extension);
  if (extension === '.svg' || declaredMime.toLowerCase() === 'image/svg+xml') {
    throw new AssetError('UnsupportedType', 'SVG assets are disabled because they can contain active content');
  }
  if (claimsImage && !image) {
    throw new AssetError('UnsupportedType', `${name} does not match a supported raster image signature`);
  }
  if (image) return image;
  return detectStoredFile(name);
}

function detectImage(bytes: Buffer): DetectedFile | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { kind: 'image', mimeType: 'image/png', extension: '.png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'image', mimeType: 'image/jpeg', extension: '.jpg' };
  }
  const ascii = bytes.subarray(0, 16).toString('ascii');
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) {
    return { kind: 'image', mimeType: 'image/gif', extension: '.gif' };
  }
  if (ascii.startsWith('RIFF') && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { kind: 'image', mimeType: 'image/webp', extension: '.webp' };
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') {
      return { kind: 'image', mimeType: 'image/avif', extension: '.avif' };
    }
  }
  return null;
}

function detectStoredFile(name: string): DetectedFile {
  const extension = extname(name).toLowerCase();
  const known = new Map<string, string>([
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

async function findExistingHash(directory: string, hash: string): Promise<string | null> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const match = /--([a-f\d]{12,64})\.[^.]+$/i.exec(entry.name);
    if (!match?.[1] || !hash.startsWith(match[1].toLowerCase())) continue;
    const path = join(directory, entry.name);
    const existingHash = createHash('sha256').update(await fs.readFile(path)).digest('hex');
    if (existingHash === hash) return path;
  }
  return null;
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

function markdownUrlFor(docPath: string, assetPath: string): string {
  const rel = relative(dirname(docPath), assetPath).split(sep).map(encodeURIComponent).join('/');
  return rel.startsWith('../') ? rel : `./${rel}`;
}

function resolveInside(root: string, relPath: string): string {
  const abs = normalize(resolve(root, relPath));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new AssetError('InvalidPayload', `path is outside project: ${relPath}`);
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
    throw new AssetError('InvalidPayload', `${path} is not a regular asset directory`);
  }
  if (stat) resolveInside(projectRoot, await fs.realpath(path));
}

function countHealth(assets: AssetEntry[]): Record<AssetHealth, number> {
  const counts: Record<AssetHealth, number> = {
    referenced: 0,
    orphan: 0,
    missing: 0,
    unmanaged: 0,
  };
  for (const asset of assets) counts[asset.health] += 1;
  return counts;
}

function healthRank(health: AssetHealth): number {
  return { missing: 0, orphan: 1, unmanaged: 2, referenced: 3 }[health];
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
