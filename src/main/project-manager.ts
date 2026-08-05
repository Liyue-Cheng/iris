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
  ConstitutionStateUi,
  ContextPreview,
  DocContent,
  DocImageResult,
  DocType,
  FsIrisChangedEvent,
  IrisScanResult,
  ProjectInitResult,
  RawTreeNode,
  SoftwareEntryStatus,
  SoftwarePromptState,
} from '@shared/types';
import { DOC_TYPES } from '@shared/types';
import { slugify, yamlScalar } from '@shared/markdown-utils';
import { parseFrontmatter, scanProject, scanRawTree } from './iris-scanner';
import { seedProjectStyleMaps } from './style-maps-store';
import { CONSTITUTION_TEMPLATE, FOREIGN_AGENT_ENTRIES } from './iris-templates';
import { assembleContextPreview, syncEntryFile } from './agent-injection';
import {
  classifyConstitution,
  classifySoftwareBlock,
  SOFTWARE_PROMPT_SHA,
} from './software-prompt';
import { logger } from './logger';

/** Entry files Iris may write the `<iris-software>` block into. */
const WRITABLE_ENTRIES: readonly string[] = ['AGENTS.md', ...FOREIGN_AGENT_ENTRIES];

const DEBOUNCE_MS = 150;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
]);

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

  /** Resolve a Markdown image relative to its document without exposing a
   *  file:// URL. SVG is intentionally excluded because active SVG content is
   *  a much broader security surface than the raster formats Iris needs. */
  async readDocImage(docPath: string, source: string): Promise<DocImageResult> {
    const root = this.requireRoot();
    if (!source || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(source)) {
      return { dataUrl: null, error: 'invalid-path' };
    }

    let cleanSource: string;
    try {
      cleanSource = decodeURIComponent(source.split(/[?#]/, 1)[0] ?? '');
    } catch {
      return { dataUrl: null, error: 'invalid-path' };
    }

    const relPath = join(dirname(docPath), cleanSource);
    let abs: string;
    try {
      abs = this.resolveInside(root, relPath);
    } catch {
      return { dataUrl: null, error: 'invalid-path' };
    }
    const extension = abs.slice(abs.lastIndexOf('.')).toLowerCase();
    const mime = IMAGE_MIME.get(extension);
    if (!mime) return { dataUrl: null, error: 'unsupported-type' };

    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return { dataUrl: null, error: 'read-failed' };
      if (stat.size > MAX_IMAGE_BYTES) return { dataUrl: null, error: 'too-large' };
      const bytes = await fs.readFile(abs);
      return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, error: null };
    } catch {
      return { dataUrl: null, error: 'read-failed' };
    }
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
    // Stored value = displayed value (规约六态/两态, 批次2).
    if (type === 'issue') fmLines.push('status: Todo');
    if (type === 'report') fmLines.push('status: Active');
    // No body H1: the typed header owns the title (frontmatter 不进正文编辑器);
    // a scaffolded heading would render the title twice.
    const content = `---\n${fmLines.join('\n')}\n---\n`;

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
   * Delete a doc (doc.delete instruction body — a HUMAN UI gesture; the
   * constitution's "do not delete issues" binds agent write-back, not the
   * user). Scoped to markdown files under .iris/ — the only files Iris owns.
   */
  async deleteDoc(relPath: string): Promise<{ path: string }> {
    const root = this.requireRoot();
    if (!/\.md$/i.test(relPath) || !relPath.replace(/\\/g, '/').startsWith('.iris/')) {
      throw new ProjectError('InvalidPayload', `refusing to delete non-iris file: ${relPath}`);
    }
    const abs = this.resolveInside(root, relPath);
    try {
      await fs.unlink(abs);
    } catch (err) {
      throw new ProjectError(
        'WriteFailed',
        `cannot delete ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { path: relPath };
  }

  /**
   * Idempotent protocol scaffold (project.init / cold start §4 冷启动):
   * ensure the four typed folders, write the constitution if absent (never
   * overwrite — it's the human-authored contract), and write/refresh the
   * `<iris-software>` block in AGENTS.md plus any existing vendor entry files
   * (§3A maintains vendor entries; never creates absent ones). Touching the
   * project root requires explicit user confirmation in the UI — the single
   * sanctioned exception to 尊重边界.
   *
   * `appVersion` and `userConstitution` are injected by the electron seam
   * (ipc.ts): version stamps the managed block; userConstitution is the
   * machine-level project-prompt default (~/.iris/templates/CONVENTIONS.md),
   * preferred over the software default when seeding (§5 三个版本). Keeping
   * them as params leaves this class electron-free and unit-testable.
   */
  async initIris(opts: {
    appVersion: string;
    userConstitution?: string | undefined;
  }): Promise<ProjectInitResult> {
    const root = this.requireRoot();
    const { appVersion, userConstitution } = opts;
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
    let constitutionSeed: ProjectInitResult['constitutionSeed'];
    const constitutionAbs = join(irisAbs, 'CONVENTIONS.md');
    if (!(await exists(constitutionAbs))) {
      const seedText = userConstitution ?? CONSTITUTION_TEMPLATE;
      await fs.writeFile(constitutionAbs, seedText, { encoding: 'utf8', flag: 'wx' });
      constitution = 'created';
      constitutionSeed = userConstitution !== undefined ? 'user-default' : 'software-default';
    }

    // Seed the project style tables from the machine defaults (never
    // overwrites an existing .iris/styles.json — project-owned from then on).
    await seedProjectStyleMaps(root);

    // AGENTS.md — the standard entry Iris owns and always writes.
    const agentsAbs = join(root, 'AGENTS.md');
    const a = await syncEntryFile(agentsAbs, appVersion);
    const agentsMd: ProjectInitResult['agentsMd'] = !a.existed
      ? 'created'
      : a.action === 'unchanged'
        ? 'already-has-section'
        : a.action === 'updated'
          ? 'updated'
          : 'appended';

    // Vendor entries: maintain the block in any that already exist; never
    // create an absent one. foreignEntries keeps the detected superset.
    const vendorEntries: ProjectInitResult['vendorEntries'] = [];
    const foreignEntries: string[] = [];
    for (const rel of FOREIGN_AGENT_ENTRIES) {
      if (!(await exists(join(root, rel)))) continue;
      foreignEntries.push(rel);
      const { action } = await syncEntryFile(join(root, rel), appVersion);
      vendorEntries.push({ path: rel, action });
    }

    logger.info(
      'project',
      `init: folders=[${createdFolders.join(', ')}] constitution=${constitution}/${constitutionSeed ?? '-'} agents=${agentsMd} vendor=[${vendorEntries.map((v) => `${v.path}:${v.action}`).join(', ')}]`,
    );
    const result: ProjectInitResult = {
      createdFolders,
      constitution,
      agentsMd,
      vendorEntries,
      foreignEntries,
    };
    if (constitutionSeed) result.constitutionSeed = constitutionSeed;
    return result;
  }

  // ── prompt governance (issue: iris软件提示词治理) ────────────────────

  /**
   * Read-only governance snapshot for the open project: the `<iris-software>`
   * block state in AGENTS.md (always listed) + any existing vendor entries,
   * and whether `.iris/CONVENTIONS.md` is still a factory default. Deterministic
   * (tag parse + hash compare); never writes.
   */
  async softwarePromptState(appVersion: string): Promise<SoftwarePromptState> {
    const root = this.requireRoot();
    const entries: SoftwareEntryStatus[] = [await this.entryStatus(root, 'AGENTS.md', true)];
    for (const rel of FOREIGN_AGENT_ENTRIES) {
      if (await exists(join(root, rel))) entries.push(await this.entryStatus(root, rel, false));
    }

    let constitution: ConstitutionStateUi;
    try {
      const text = await fs.readFile(join(root, '.iris', 'CONVENTIONS.md'), 'utf8');
      constitution = classifyConstitution(text);
    } catch {
      constitution = 'missing';
    }

    return { appVersion, currentSha: SOFTWARE_PROMPT_SHA, entries, constitution: { state: constitution } };
  }

  /**
   * Read-only content view of the governed prompt layers + the assembled
   * injection an agent receives — the text behind the freshness badges, for the
   * settings 软件提示词 viewer. Pure read (never writes).
   */
  async contextPreview(appVersion: string): Promise<ContextPreview> {
    return assembleContextPreview(this.requireRoot(), appVersion);
  }

  private async entryStatus(
    root: string,
    rel: string,
    isStandard: boolean,
  ): Promise<SoftwareEntryStatus> {
    try {
      const text = await fs.readFile(this.resolveInside(root, rel), 'utf8');
      const { state, version } = classifySoftwareBlock(text);
      return version !== undefined
        ? { path: rel, isStandard, state, version }
        : { path: rel, isStandard, state };
    } catch {
      return { path: rel, isStandard, state: 'no-entry' };
    }
  }

  /**
   * Write/refresh the `<iris-software>` block in one entry file (user-confirmed
   * in the settings UI; .bak written first by syncEntryFile). AGENTS.md may be
   * created; a vendor entry is refused if it does not already exist (Iris never
   * grows a vendor zoo). Returns the fresh state for the UI to re-render.
   */
  async syncSoftwareEntry(relPath: string, appVersion: string): Promise<SoftwarePromptState> {
    const root = this.requireRoot();
    if (!WRITABLE_ENTRIES.includes(relPath)) {
      throw new ProjectError('InvalidPayload', `refusing to write the block into ${relPath}`);
    }
    const abs = this.resolveInside(root, relPath);
    if (relPath !== 'AGENTS.md' && !(await exists(abs))) {
      throw new ProjectError('InvalidPayload', `vendor entry ${relPath} does not exist (Iris does not create it)`);
    }
    await syncEntryFile(abs, appVersion);
    return this.softwarePromptState(appVersion);
  }

  /**
   * Upgrade `.iris/CONVENTIONS.md` to the current shipped default — ONLY when
   * it is still an untouched prior factory default (§5). A current-default,
   * customized, or missing constitution is refused: Iris never overwrites
   * human edits. .bak written first.
   */
  async upgradeConstitution(appVersion: string): Promise<SoftwarePromptState> {
    const root = this.requireRoot();
    const abs = join(root, '.iris', 'CONVENTIONS.md');
    let text: string;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      throw new ProjectError('ReadFailed', '.iris/CONVENTIONS.md not found');
    }
    if (classifyConstitution(text) !== 'stale-default') {
      throw new ProjectError(
        'InvalidPayload',
        '宪法不是可升级的出厂旧默认（当前已是最新、或已被自定义）——拒绝覆盖',
      );
    }
    await fs.copyFile(abs, `${abs}.bak`).catch(() => {});
    await fs.writeFile(abs, CONSTITUTION_TEMPLATE, 'utf8');
    logger.info('project', `constitution upgraded to current default (.bak kept): ${abs}`);
    return this.softwarePromptState(appVersion);
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
