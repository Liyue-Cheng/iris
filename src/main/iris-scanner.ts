/**
 * @file src/main/iris-scanner.ts
 * @purpose The protocol's read side — project the .iris/ tree into the
 *   workspace/type/doc data model. This is the deterministic rendering
 *   layer's load-bearing wall (software-definition.md §2/§3):
 *
 *   - Name-is-type, recursive: a folder named status/issue/report/misc at
 *     ANY depth is a typed folder; a doc's type comes from its NEAREST
 *     enclosing typed folder.
 *   - Workspaces are inferred, never declared: any folder containing at
 *     least one typed folder is a workspace. `.iris/` is the root workspace.
 *   - A doc belongs to the nearest enclosing workspace.
 *   - Archive gesture: a workspace nested anywhere inside a report/ folder
 *     is archived (frozen past, renders grayed).
 *
 *   Keys are hard (folder names, frontmatter keys parsed literally); values
 *   are soft (`status:` etc. pass through verbatim — no validation here,
 *   constraints live in the prose spec, not the type system).
 *
 * Pure logic + fs reads only. No watching, no state — that's
 * project-manager's job. Unit-tested against fixtures/sample-project.
 */
import { promises as fs } from 'node:fs';
import { basename, join, sep } from 'node:path';
import matter from 'gray-matter';
import {
  DOC_TYPES,
  type DocType,
  type IrisDoc,
  type IrisScanResult,
  type IrisWorkspace,
  type RawTreeNode,
} from '@shared/types';
import { logger } from './logger';

const IRIS_DIR = '.iris';

function isDocType(name: string): name is DocType {
  return (DOC_TYPES as readonly string[]).includes(name);
}

/** Project-relative path with forward slashes (protocol portable form). */
function toRel(projectRoot: string, absPath: string): string {
  return absPath.slice(projectRoot.length + 1).split(sep).join('/');
}

interface DirListing {
  dirs: { name: string; abs: string }[];
  files: { name: string; abs: string }[];
}

async function listDir(abs: string): Promise<DirListing> {
  const out: DirListing = { dirs: [], files: [] };
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    logger.warn('scanner', `readdir failed for ${abs}`, err);
    return out;
  }
  for (const e of entries) {
    const child = join(abs, e.name);
    if (e.isDirectory()) out.dirs.push({ name: e.name, abs: child });
    else if (e.isFile()) out.files.push({ name: e.name, abs: child });
  }
  return out;
}

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown> | null;
  broken: boolean;
}

/**
 * Parse frontmatter tolerantly. Broken YAML degrades to "no metadata" with
 * the broken flag set — the doc still shows up (degrade loudly-visible,
 * never swallow silently). Pure function, no logging — callers attach the
 * file path to any warning (a pathless YAML error blames the wrong doc).
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const hasFmFence = /^---\r?\n/.test(text);
  if (!hasFmFence) return { frontmatter: null, broken: false };
  try {
    // Always pass an options object: gray-matter's no-options path writes
    // its cache BEFORE parsing, so a file whose YAML throws poisons the
    // cache and every later parse of the same content silently "succeeds"
    // with empty data. Any options object bypasses that cache entirely.
    const parsed = matter(text, {});
    const data = parsed.data as Record<string, unknown>;
    return {
      frontmatter: Object.keys(data).length > 0 ? data : null,
      broken: false,
    };
  } catch {
    return { frontmatter: null, broken: true };
  }
}

/** Warn once per (path, mtime) — rescans are frequent, log spam isn't useful. */
const warnedBrokenFm = new Map<string, number>();

function warnBrokenFrontmatter(relPath: string, mtimeMs: number): void {
  if (warnedBrokenFm.get(relPath) === mtimeMs) return;
  warnedBrokenFm.set(relPath, mtimeMs);
  logger.warn('scanner', `frontmatter broken in ${relPath} — degraded to no-metadata`);
}

function fmString(fm: Record<string, unknown> | null, key: string): string | null {
  const v = fm?.[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return null;
}

async function readDocMeta(
  projectRoot: string,
  absPath: string,
  type: DocType,
  workspacePath: string,
): Promise<IrisDoc> {
  let text = '';
  let mtimeMs = 0;
  try {
    const [content, stat] = await Promise.all([fs.readFile(absPath, 'utf8'), fs.stat(absPath)]);
    text = content;
    mtimeMs = stat.mtimeMs;
  } catch (err) {
    logger.warn('scanner', `read failed for ${absPath}`, err);
  }
  const { frontmatter, broken } = parseFrontmatter(text);
  const relPath = toRel(projectRoot, absPath);
  if (broken) warnBrokenFrontmatter(relPath, mtimeMs);
  return {
    path: relPath,
    name: basename(absPath),
    type,
    workspacePath,
    title: fmString(frontmatter, 'title'),
    status: fmString(frontmatter, 'status'),
    frontmatter,
    frontmatterBroken: broken,
    mtimeMs,
  };
}

/**
 * Recursively collect docs inside a typed folder. Sub-DIRECTORIES inside a
 * typed folder are free-form (tree shape is soft) — UNLESS a subdir is
 * itself a workspace (contains typed folders): that subtree belongs to the
 * nested workspace and is handled by scanWorkspaceDir, not here.
 */
async function collectTypedDocs(
  projectRoot: string,
  typedDirAbs: string,
  type: DocType,
  workspacePath: string,
  nestedWorkspaces: IrisWorkspace[],
  insideReport: boolean,
): Promise<IrisDoc[]> {
  const docs: IrisDoc[] = [];
  const { dirs, files } = await listDir(typedDirAbs);

  for (const f of files) {
    if (!f.name.toLowerCase().endsWith('.md')) continue;
    docs.push(await readDocMeta(projectRoot, f.abs, type, workspacePath));
  }

  for (const d of dirs) {
    if (await isWorkspaceDir(d.abs)) {
      // A workspace living inside a typed folder — the archive gesture when
      // that folder is report/. Recurse as a full workspace.
      nestedWorkspaces.push(
        await scanWorkspaceDir(projectRoot, d.abs, insideReport || type === 'report'),
      );
    } else if (isDocType(d.name)) {
      // A typed folder nested directly inside another typed folder re-types
      // its subtree (nearest-typed-folder rule).
      docs.push(
        ...(await collectTypedDocs(
          projectRoot,
          d.abs,
          d.name,
          workspacePath,
          nestedWorkspaces,
          insideReport || type === 'report',
        )),
      );
    } else {
      // Free-form subdir: same type continues to apply.
      docs.push(
        ...(await collectTypedDocs(
          projectRoot,
          d.abs,
          type,
          workspacePath,
          nestedWorkspaces,
          insideReport,
        )),
      );
    }
  }
  return docs;
}

/** A folder is a workspace iff it directly contains at least one typed folder. */
async function isWorkspaceDir(abs: string): Promise<boolean> {
  const { dirs } = await listDir(abs);
  return dirs.some((d) => isDocType(d.name));
}

/**
 * Scan a workspace directory: typed-folder children become this workspace's
 * docs; non-typed dirs are searched for nested workspaces; loose .md files
 * at the workspace root (index.md, CONVENTIONS.md) are not typed docs and
 * stay out of the lens tree (visible via the raw tree).
 */
async function scanWorkspaceDir(
  projectRoot: string,
  wsAbs: string,
  archived: boolean,
): Promise<IrisWorkspace> {
  const wsRel = toRel(projectRoot, wsAbs);
  const ws: IrisWorkspace = {
    path: wsRel,
    name: basename(wsAbs),
    docs: [],
    children: [],
    archived,
  };

  const { dirs } = await listDir(wsAbs);
  for (const d of dirs) {
    if (isDocType(d.name)) {
      ws.docs.push(
        ...(await collectTypedDocs(projectRoot, d.abs, d.name, wsRel, ws.children, archived)),
      );
    } else if (await containsWorkspaceSomewhere(d.abs)) {
      // Non-typed folder that (transitively) holds workspaces: descend so
      // arbitrarily organized sub-workspaces are still found.
      ws.children.push(...(await findWorkspaces(projectRoot, d.abs, archived)));
    }
  }

  ws.docs.sort((a, b) => a.path.localeCompare(b.path));
  ws.children.sort((a, b) => a.path.localeCompare(b.path));
  return ws;
}

/** Depth-first: does any descendant folder qualify as a workspace? */
async function containsWorkspaceSomewhere(abs: string): Promise<boolean> {
  if (await isWorkspaceDir(abs)) return true;
  const { dirs } = await listDir(abs);
  for (const d of dirs) {
    if (await containsWorkspaceSomewhere(d.abs)) return true;
  }
  return false;
}

/** Collect the SHALLOWEST workspaces under a non-typed dir. */
async function findWorkspaces(
  projectRoot: string,
  abs: string,
  archived: boolean,
): Promise<IrisWorkspace[]> {
  if (await isWorkspaceDir(abs)) {
    return [await scanWorkspaceDir(projectRoot, abs, archived)];
  }
  const out: IrisWorkspace[] = [];
  const { dirs } = await listDir(abs);
  for (const d of dirs) {
    out.push(...(await findWorkspaces(projectRoot, d.abs, archived)));
  }
  return out;
}

/** Read .iris/CONVENTIONS.md presence + frontmatter protocol version. */
async function readConstitutionState(
  irisAbs: string,
): Promise<{ exists: boolean; protocol: number | null }> {
  try {
    const text = await fs.readFile(join(irisAbs, 'CONVENTIONS.md'), 'utf8');
    const { frontmatter } = parseFrontmatter(text);
    const p = frontmatter?.['protocol'];
    return { exists: true, protocol: typeof p === 'number' ? p : null };
  } catch {
    return { exists: false, protocol: null };
  }
}

/** Scan a project. Cheap full rescan (M1 granularity — .iris trees are small). */
export async function scanProject(projectRoot: string): Promise<IrisScanResult> {
  const projectName = basename(projectRoot);
  const irisAbs = join(projectRoot, IRIS_DIR);

  let hasIris = false;
  try {
    hasIris = (await fs.stat(irisAbs)).isDirectory();
  } catch {
    hasIris = false;
  }

  if (!hasIris) {
    return {
      projectRoot,
      projectName,
      hasIris: false,
      root: null,
      constitution: { exists: false, protocol: null },
      scannedAt: Date.now(),
    };
  }

  const [root, constitution] = await Promise.all([
    scanWorkspaceDir(projectRoot, irisAbs, false),
    readConstitutionState(irisAbs),
  ]);
  root.name = projectName; // root workspace displays the project's name
  return { projectRoot, projectName, hasIris: true, root, constitution, scannedAt: Date.now() };
}

/** Raw file tree of .iris/ (escape-hatch view). Dirs first, then files. */
export async function scanRawTree(projectRoot: string): Promise<RawTreeNode | null> {
  const irisAbs = join(projectRoot, IRIS_DIR);
  try {
    if (!(await fs.stat(irisAbs)).isDirectory()) return null;
  } catch {
    return null;
  }

  async function walk(abs: string): Promise<RawTreeNode> {
    const { dirs, files } = await listDir(abs);
    const children: RawTreeNode[] = [];
    for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
      children.push(await walk(d.abs));
    }
    for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
      children.push({ name: f.name, path: toRel(projectRoot, f.abs), kind: 'file' });
    }
    return { name: basename(abs), path: toRel(projectRoot, abs), kind: 'dir', children };
  }

  return walk(irisAbs);
}
