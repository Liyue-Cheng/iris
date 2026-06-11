/**
 * @file src/main/project-manager.ts
 * @purpose Current-project lifecycle: open/close, chokidar watch over .iris/,
 *   debounced change batching, and the read queries (scan / raw tree /
 *   doc read) scoped to the open project.
 *
 * v1 manages exactly one project at a time (software-definition.md §7).
 * Opening a new project tears down the previous watcher.
 *
 * Watching follows the contract "files are the contract": Iris never parses
 * agent output — every change, whether from the editor, an agent session or
 * an external tool, arrives here as a file event and flows to the renderer
 * as evt:fs:iris-changed, where an ISR re-projects.
 */
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type {
  DocContent,
  DocType,
  FsIrisChangedEvent,
  IrisScanResult,
  ProjectInitResult,
  RawTreeNode,
} from '@shared/types';
import { DOC_TYPES } from '@shared/types';
import { slugify, yamlScalar } from '@shared/markdown-utils';
import { parseFrontmatter, scanProject, scanRawTree } from './iris-scanner';
import {
  AGENTS_GUIDANCE,
  AGENTS_GUIDANCE_MARKER,
  CONSTITUTION_TEMPLATE,
} from './iris-templates';
import { logger } from './logger';

const DEBOUNCE_MS = 150;

export class ProjectError extends Error {
  constructor(
    public readonly code:
      | 'NotADirectory'
      | 'NoProject'
      | 'OutsideProject'
      | 'ReadFailed'
      | 'WriteFailed'
      | 'InvalidPayload',
    message: string,
  ) {
    super(`[ProjectManager] ${code}: ${message}`);
    this.name = 'ProjectError';
  }
}

export class ProjectManager extends EventEmitter {
  private projectRoot: string | null = null;
  private watcher: FSWatcher | null = null;
  private pendingChanges: FsIrisChangedEvent['changes'] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  /** Absolute root of the currently open project (null when none). */
  getRoot(): string | null {
    return this.projectRoot;
  }

  /**
   * Open a project: validate the directory, start watching its .iris/ tree
   * (if present), and return the initial scan. Replaces any previous project.
   */
  async open(root: string): Promise<IrisScanResult> {
    const abs = normalize(resolve(root));
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new ProjectError('NotADirectory', `cannot access ${abs}`);
    }
    if (!stat.isDirectory()) {
      throw new ProjectError('NotADirectory', `${abs} is not a directory`);
    }

    await this.close();
    this.projectRoot = abs;

    const result = await scanProject(abs);
    // Watch even when .iris/ doesn't exist yet: its later creation (manual
    // mkdir or the M5 init wizard) must light the tree up without a restart.
    this.startWatcher(abs);
    logger.info('project', `opened ${abs} (hasIris=${result.hasIris})`);
    return result;
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingChanges = [];
    if (this.watcher) {
      await this.watcher.close().catch(() => {});
      this.watcher = null;
    }
    this.projectRoot = null;
  }

  /** Rescan the open project (projection query). */
  async scan(): Promise<IrisScanResult> {
    const root = this.requireRoot();
    return scanProject(root);
  }

  async rawTree(): Promise<RawTreeNode | null> {
    const root = this.requireRoot();
    return scanRawTree(root);
  }

  /** Read one doc (projection query). Path must stay inside the project. */
  async readDoc(relPath: string): Promise<DocContent> {
    const root = this.requireRoot();
    const abs = this.resolveInside(root, relPath);
    let raw: string;
    try {
      raw = await fs.readFile(abs, 'utf8');
    } catch (err) {
      throw new ProjectError(
        'ReadFailed',
        `cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const { frontmatter, broken } = parseFrontmatter(raw);
    const body = broken || frontmatter !== null ? stripFrontmatter(raw) : raw;
    return { path: relPath, raw, body, frontmatter, frontmatterBroken: broken };
  }

  /**
   * Write a doc verbatim (doc.save instruction body). The renderer composed
   * the exact bytes; main adds nothing — same atomic tmp+rename discipline
   * as JsonStore so a crash never leaves a half-written doc.
   */
  async writeDoc(relPath: string, content: string): Promise<{ path: string }> {
    const root = this.requireRoot();
    if (typeof content !== 'string') {
      throw new ProjectError('InvalidPayload', 'content must be a string');
    }
    const abs = this.resolveInside(root, relPath);
    const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`;
    try {
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(tmp, content, 'utf8');
      await fs.rename(tmp, abs);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw new ProjectError(
        'WriteFailed',
        `cannot write ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { path: relPath };
  }

  /**
   * Create a doc in a typed folder (doc.create instruction body).
   * issue/report names get the protocol's date prefix (concurrent creation
   * by multiple humans/agents must not collide); collisions append -2, -3…
   */
  async createDoc(payload: {
    workspacePath: string;
    type: DocType;
    title: string;
  }): Promise<{ path: string }> {
    const root = this.requireRoot();
    const { workspacePath, type, title } = payload;
    if (!workspacePath || !type || typeof title !== 'string') {
      throw new ProjectError('InvalidPayload', 'workspacePath, type and title are required');
    }
    const slug = slugify(title);
    const today = new Date();
    const datePrefix = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}-`;
    const baseName = (type === 'issue' || type === 'report' ? datePrefix : '') + slug;

    const dirAbs = this.resolveInside(root, `${workspacePath}/${type}`);
    await fs.mkdir(dirAbs, { recursive: true });

    let fileName = `${baseName}.md`;
    for (let n = 2; ; n++) {
      try {
        await fs.access(join(dirAbs, fileName));
        fileName = `${baseName}-${n}.md`; // exists → try next
      } catch {
        break; // free
      }
    }

    const fmLines = [`title: ${yamlScalar(title)}`];
    if (type === 'issue') fmLines.push('status: todo');
    const content = `---\n${fmLines.join('\n')}\n---\n\n# ${title}\n`;

    const relPath = `${workspacePath}/${type}/${fileName}`;
    const abs = this.resolveInside(root, relPath);
    try {
      // wx: fail rather than overwrite if a race sneaks in after the probe
      await fs.writeFile(abs, content, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      throw new ProjectError(
        'WriteFailed',
        `cannot create ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { path: relPath };
  }

  /**
   * Idempotent protocol scaffold (project.init / cold start §4 冷启动):
   * ensure the four typed folders, write the constitution if absent (never
   * overwrite — it's the human-authored contract), and append the guidance
   * section to AGENTS.md exactly once (marker-checked). Touching the
   * project root requires explicit user confirmation in the UI — this is
   * the single sanctioned exception to 尊重边界.
   */
  async initIris(): Promise<ProjectInitResult> {
    const root = this.requireRoot();
    const irisAbs = join(root, '.iris');

    const createdFolders: string[] = [];
    for (const t of DOC_TYPES) {
      const dir = join(irisAbs, t);
      if (!(await exists(dir))) {
        await fs.mkdir(dir, { recursive: true });
        createdFolders.push(`.iris/${t}`);
      }
    }

    let constitution: ProjectInitResult['constitution'] = 'already-exists';
    const constitutionAbs = join(irisAbs, 'CONVENTIONS.md');
    if (!(await exists(constitutionAbs))) {
      await fs.writeFile(constitutionAbs, CONSTITUTION_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
      constitution = 'created';
    }

    let agentsMd: ProjectInitResult['agentsMd'];
    const agentsAbs = join(root, 'AGENTS.md');
    if (!(await exists(agentsAbs))) {
      await fs.writeFile(agentsAbs, `${AGENTS_GUIDANCE}`, 'utf8');
      agentsMd = 'created';
    } else {
      const current = await fs.readFile(agentsAbs, 'utf8');
      if (current.includes(AGENTS_GUIDANCE_MARKER)) {
        agentsMd = 'already-has-section';
      } else {
        const sep = current.endsWith('\n') ? '\n' : '\n\n';
        await fs.appendFile(agentsAbs, `${sep}${AGENTS_GUIDANCE}`, 'utf8');
        agentsMd = 'appended';
      }
    }

    logger.info('project', `init: folders=[${createdFolders.join(', ')}] constitution=${constitution} agents=${agentsMd}`);
    return { createdFolders, constitution, agentsMd };
  }

  /**
   * Create a sub-workspace (workspace.create — a HUMAN gesture, agents
   * never create workspaces unasked). Templates: 'standard' = the four
   * typed folders; 'empty' = bare folder the user shapes later.
   */
  async createWorkspace(payload: {
    parentPath: string;
    name: string;
    template: 'standard' | 'empty';
  }): Promise<{ path: string }> {
    const root = this.requireRoot();
    const { parentPath, name, template } = payload;
    const trimmed = (name ?? '').trim();
    if (!trimmed || /[\\/:*?"<>|]/.test(trimmed) || trimmed.startsWith('.')) {
      throw new ProjectError('InvalidPayload', `工作区名不合法: "${name}"`);
    }
    if ((DOC_TYPES as readonly string[]).includes(trimmed)) {
      throw new ProjectError(
        'InvalidPayload',
        `"${trimmed}" 是类型文件夹的保留名（名字即类型），不能用作工作区名`,
      );
    }
    const wsAbs = this.resolveInside(root, `${parentPath}/${trimmed}`);
    if (await exists(wsAbs)) {
      throw new ProjectError('WriteFailed', `"${parentPath}/${trimmed}" 已存在`);
    }
    await fs.mkdir(wsAbs, { recursive: true });
    if (template === 'standard') {
      for (const t of DOC_TYPES) {
        await fs.mkdir(join(wsAbs, t), { recursive: true });
      }
    }
    return { path: `${parentPath}/${trimmed}` };
  }

  // ──────────────────────────────────────────────────────────────────

  private requireRoot(): string {
    if (!this.projectRoot) throw new ProjectError('NoProject', 'no project is open');
    return this.projectRoot;
  }

  /** Path-traversal guard: resolved path must stay under the project root. */
  private resolveInside(root: string, relPath: string): string {
    const abs = normalize(resolve(root, relPath));
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new ProjectError('OutsideProject', `${relPath} escapes the project root`);
    }
    return abs;
  }

  private startWatcher(root: string): void {
    const irisAbs = join(root, '.iris');
    this.watcher = chokidar.watch(irisAbs, {
      ignoreInitial: true,
      // Editors/agents writing files produce write bursts; wait for quiet.
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
    });

    const push = (kind: FsIrisChangedEvent['changes'][number]['kind']) => (path: string) => {
      if (!this.projectRoot) return;
      const rel = path.slice(this.projectRoot.length + 1).split(sep).join('/');
      this.pendingChanges.push({ kind, path: rel });
      this.scheduleFlush();
    };

    this.watcher
      .on('add', push('add'))
      .on('change', push('change'))
      .on('unlink', push('unlink'))
      .on('addDir', push('addDir'))
      .on('unlinkDir', push('unlinkDir'))
      .on('error', (err) => logger.warn('project', 'watcher error', err));
  }

  /** Debounce: agents touch several files per task; one batch, one rescan. */
  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.projectRoot || this.pendingChanges.length === 0) return;
      const event: FsIrisChangedEvent = {
        projectRoot: this.projectRoot,
        changes: this.pendingChanges,
      };
      this.pendingChanges = [];
      this.emit('irisChanged', event);
    }, DEBOUNCE_MS);
  }
}

/** Remove the frontmatter block (first `--- ... ---`) from raw text. */
export function stripFrontmatter(raw: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return m ? raw.slice(m[0].length) : raw;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
