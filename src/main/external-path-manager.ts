import { promises as fs } from 'node:fs';
import {
  basename,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  ExternalPathEntry,
  ExternalPathIdentity,
  WorkspaceExternalPaths,
} from '@shared/types';
import { writeFileAtomic } from './atomic-write';

export const EXTERNAL_PATHS_FILE = 'external.txt';

export class ExternalPathError extends Error {
  constructor(
    public readonly code:
      | 'InvalidPayload'
      | 'ReadFailed'
      | 'WriteConflict'
      | 'WriteFailed'
      | 'NotFound',
    message: string,
  ) {
    super(`[ExternalPathManager] ${code}: ${message}`);
    this.name = 'ExternalPathError';
  }
}

export class ExternalPathManager {
  async list(projectRoot: string, workspacePath: string): Promise<WorkspaceExternalPaths> {
    const workspaceAbs = await requireWorkspace(projectRoot, workspacePath);
    const manifestPath = portable(join(workspacePath, EXTERNAL_PATHS_FILE));
    const manifestAbs = join(workspaceAbs, EXTERNAL_PATHS_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(manifestAbs, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        return { workspacePath, manifestPath, exists: false, entries: [], diagnostics: [] };
      }
      return {
        workspacePath,
        manifestPath,
        exists: true,
        entries: [],
        diagnostics: [{ line: null, message: messageFor(error) }],
      };
    }
    return {
      workspacePath,
      manifestPath,
      exists: true,
      ...(await parseExternalPaths(raw, workspaceAbs)),
    };
  }

  async add(
    projectRoot: string,
    workspacePath: string,
    targetPath: string,
  ): Promise<ExternalPathEntry> {
    const workspaceAbs = await requireWorkspace(projectRoot, workspacePath);
    const rawTarget = (targetPath ?? '').trim();
    if (!rawTarget || /[\r\n\u0000]/.test(rawTarget)) {
      throw new ExternalPathError('InvalidPayload', 'Path must be one non-empty line');
    }
    const absolute = normalize(isAbsolute(rawTarget) ? rawTarget : resolve(workspaceAbs, rawTarget));
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat || (!stat.isFile() && !stat.isDirectory())) {
      throw new ExternalPathError('InvalidPayload', `Target does not exist: ${rawTarget}`);
    }

    const manifestAbs = join(workspaceAbs, EXTERNAL_PATHS_FILE);
    const current = await readManifest(manifestAbs);
    const parsed = await parseExternalPaths(current, workspaceAbs);
    const existing = parsed.entries.find((entry) => samePath(entry.absolutePath, absolute));
    if (existing) return existing;

    const storedPath = storedPathFor(workspaceAbs, projectRoot, absolute);
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    const next = `${current}${separator}${storedPath}\n`;
    try {
      await writeFileAtomic(manifestAbs, next);
    } catch (error) {
      throw new ExternalPathError('WriteFailed', messageFor(error));
    }
    return makeEntry(storedPath, absolute, lineCountBeforeAppend(current), stat);
  }

  async remove(projectRoot: string, identity: ExternalPathIdentity): Promise<void> {
    const workspaceAbs = await requireWorkspace(projectRoot, identity.workspacePath);
    const manifestAbs = join(workspaceAbs, EXTERNAL_PATHS_FILE);
    const current = await readManifestRequired(manifestAbs);
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const hadFinalEol = /\r?\n$/.test(current);
    const lines = current.split(/\r?\n/);
    if (hadFinalEol) lines.pop();
    const actual = lines[identity.line]?.replace(/^\uFEFF/, '').trim();
    if (actual !== identity.storedPath) {
      throw new ExternalPathError('WriteConflict', 'external.txt changed; refresh before removing');
    }
    lines.splice(identity.line, 1);
    const next = `${lines.join(eol)}${hadFinalEol && lines.length > 0 ? eol : ''}`;
    try {
      await writeFileAtomic(manifestAbs, next);
    } catch (error) {
      throw new ExternalPathError('WriteFailed', messageFor(error));
    }
  }

  async resolve(projectRoot: string, identity: ExternalPathIdentity): Promise<ExternalPathEntry> {
    const inventory = await this.list(projectRoot, identity.workspacePath);
    const entry = inventory.entries.find(
      (candidate) => candidate.line === identity.line && candidate.storedPath === identity.storedPath,
    );
    if (!entry) throw new ExternalPathError('WriteConflict', 'external.txt changed; refresh and retry');
    if (!entry.exists || !entry.absolutePath || !entry.kind) {
      throw new ExternalPathError('NotFound', `External path is unavailable: ${identity.storedPath}`);
    }
    return entry;
  }
}

async function parseExternalPaths(
  raw: string,
  workspaceAbs: string,
): Promise<Pick<WorkspaceExternalPaths, 'entries' | 'diagnostics'>> {
  const entries: ExternalPathEntry[] = [];
  const diagnostics: WorkspaceExternalPaths['diagnostics'] = [];
  const seen = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (let line = 0; line < lines.length; line += 1) {
    const storedPath = (lines[line] ?? '').replace(/^\uFEFF/, '').trim();
    if (!storedPath || storedPath.startsWith('#')) continue;
    const resolved = resolveStoredPath(workspaceAbs, storedPath);
    if (!resolved.absolutePath) {
      const entry = invalidEntry(storedPath, line, resolved.error);
      entries.push(entry);
      diagnostics.push({ line, message: entry.error ?? 'invalid' });
      continue;
    }
    const key = pathKey(resolved.absolutePath);
    if (seen.has(key)) continue;
    seen.add(key);
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    let error: ExternalPathEntry['error'] = null;
    try {
      stat = await fs.stat(resolved.absolutePath);
    } catch (cause) {
      error = isNotFound(cause) ? 'missing' : 'unreadable';
    }
    const entry = makeEntry(storedPath, resolved.absolutePath, line, stat, error);
    entries.push(entry);
    if (entry.error) diagnostics.push({ line, message: entry.error });
  }
  return { entries, diagnostics };
}

function resolveStoredPath(
  workspaceAbs: string,
  storedPath: string,
): { absolutePath: string | null; error: ExternalPathEntry['error'] } {
  if (/\u0000/.test(storedPath)) return { absolutePath: null, error: 'invalid' };
  if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(storedPath)) {
    return { absolutePath: null, error: 'unsupported-platform' };
  }
  try {
    return {
      absolutePath: normalize(isAbsolute(storedPath) ? storedPath : resolve(workspaceAbs, storedPath)),
      error: null,
    };
  } catch {
    return { absolutePath: null, error: 'invalid' };
  }
}

function makeEntry(
  storedPath: string,
  absolutePath: string,
  line: number,
  stat: Awaited<ReturnType<typeof fs.stat>> | null,
  error: ExternalPathEntry['error'] = null,
): ExternalPathEntry {
  const kind = stat?.isDirectory() ? 'directory' : stat?.isFile() ? 'file' : null;
  return {
    storedPath,
    absolutePath,
    name: basename(absolutePath) || absolutePath,
    kind,
    exists: kind !== null,
    line,
    error: error ?? (kind === null ? 'invalid' : null),
  };
}

function invalidEntry(
  storedPath: string,
  line: number,
  error: ExternalPathEntry['error'],
): ExternalPathEntry {
  return {
    storedPath,
    absolutePath: null,
    name: basename(storedPath.replace(/\\/g, '/')) || storedPath,
    kind: null,
    exists: false,
    line,
    error: error ?? 'invalid',
  };
}

async function requireWorkspace(projectRoot: string, workspacePath: string): Promise<string> {
  const portablePath = workspacePath.replace(/\\/g, '/');
  if (portablePath !== '.iris' && !portablePath.startsWith('.iris/')) {
    throw new ExternalPathError('InvalidPayload', `Not an Iris workspace path: ${workspacePath}`);
  }
  const absolute = resolveInside(projectRoot, portablePath);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new ExternalPathError('InvalidPayload', `Workspace is unavailable: ${workspacePath}`);
  }
  return absolute;
}

function storedPathFor(workspaceAbs: string, projectRoot: string, absolute: string): string {
  const relToProject = relative(projectRoot, absolute);
  const canBePortable =
    relToProject !== '' &&
    relToProject !== '..' &&
    !relToProject.startsWith(`..${sep}`) &&
    !isAbsolute(relToProject);
  if (!canBePortable) return absolute;
  const stored = portable(relative(workspaceAbs, absolute)) || '.';
  // A workspace can reference itself, or a local filename beginning with #.
  // Neither may turn into an empty line or a comment on the next read.
  return stored.startsWith('#') ? `./${stored}` : stored;
}

function resolveInside(root: string, relPath: string): string {
  const absolute = normalize(resolve(root, relPath));
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new ExternalPathError('InvalidPayload', `Path leaves the project: ${relPath}`);
  }
  return absolute;
}

async function readManifest(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return '';
    throw new ExternalPathError('ReadFailed', messageFor(error));
  }
}

async function readManifestRequired(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (error) {
    throw new ExternalPathError(isNotFound(error) ? 'WriteConflict' : 'ReadFailed', messageFor(error));
  }
}

function samePath(left: string | null, right: string): boolean {
  return left !== null && pathKey(left) === pathKey(right);
}

function pathKey(path: string): string {
  const normalized = normalize(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function lineCountBeforeAppend(raw: string): number {
  if (raw === '') return 0;
  return raw.split(/\r?\n/).length - (/\r?\n$/.test(raw) ? 1 : 0);
}

function portable(path: string): string {
  return path.split(sep).join('/');
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
