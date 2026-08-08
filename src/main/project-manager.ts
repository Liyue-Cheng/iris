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
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type {
  AssetImportPayload,
  AssetImportResult,
  AssetInventory,
  ContextPreview,
  DocContent,
  DocImageResult,
  DocType,
  FsIrisChangedEvent,
  IrisScanResult,
  ProjectInitResult,
  ProjectPromptConflict,
  RawTreeNode,
  SoftwareEntryStatus,
  SoftwarePromptState,
} from '@shared/types';
import { DOC_TYPES } from '@shared/types';
import { slugify } from '@shared/markdown-utils';
import { parseFrontmatter, scanProject, scanRawTree } from './iris-scanner';
import { FOREIGN_AGENT_ENTRIES } from './iris-templates';
import { assembleContextPreview, syncEntryFile } from './agent-injection';
import {
  classifySoftwareBlock,
  docSkeleton,
  normalizePromptBody,
  parseProjectBlock,
  upsertProjectBlock,
} from './software-prompt';
import { logger } from './logger';
import { AssetManager } from './asset-manager';

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
      | 'WriteConflict'
      | 'WriteFailed'
      | 'InvalidPayload',
    message: string,
  ) {
    super(`[ProjectManager] ${code}: ${message}`);
    this.name = 'ProjectError';
  }
}

export interface PreparedProject {
  root: string;
  scan: IrisScanResult;
}

export class ProjectManager extends EventEmitter {
  private readonly assetManager = new AssetManager();
  private projectRoot: string | null = null;
  private watcher: FSWatcher | null = null;
  private pendingChanges: FsIrisChangedEvent['changes'] = [];
  private pendingPromptChanges: FsIrisChangedEvent['changes'] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private promptReconcileTail: Promise<void> = Promise.resolve();
  private projectPromptBaseline = '';
  private projectPromptConflicts: ProjectPromptConflict[] = [];

  /** Absolute root of the currently open project (null when none). */
  getRoot(): string | null {
    return this.projectRoot;
  }

  /**
   * Validate and scan a target without disturbing the currently open project.
   * Project switching uses this as its reversible preparation phase.
   */
  async prepareOpen(root: string): Promise<PreparedProject> {
    const abs = normalize(resolve(root));
    let canonicalRoot: string;
    let stat;
    try {
      canonicalRoot = normalize(await fs.realpath(abs));
      stat = await fs.stat(canonicalRoot);
    } catch {
      throw new ProjectError('NotADirectory', `cannot access ${abs}`);
    }
    if (!stat.isDirectory()) {
      throw new ProjectError('NotADirectory', `${canonicalRoot} is not a directory`);
    }

    return { root: canonicalRoot, scan: await scanProject(canonicalRoot) };
  }

  /** Commit a prepared project and replace the current watcher. */
  async activatePrepared(prepared: PreparedProject): Promise<IrisScanResult> {
    await this.close();
    this.projectRoot = prepared.root;

    // Project switch becomes irreversible before activation: old PTYs have
    // already been drained. Prompt mirroring and watcher setup are auxiliary
    // services, so failures here degrade the opened project instead of
    // stranding main on B while renderer rolls back to A.
    try {
      await this.reconcileProjectPromptInitial(prepared.root);
    } catch (err) {
      logger.warn('project', `initial project prompt reconciliation failed for ${prepared.root}`, err);
    }

    // Watch even when .iris/ doesn't exist yet: its later creation (manual
    // mkdir or the M5 init wizard) must light the tree up without a restart.
    try {
      this.startWatcher(prepared.root);
    } catch (err) {
      logger.warn('project', `watcher setup failed for ${prepared.root}`, err);
    }
    logger.info('project', `opened ${prepared.root} (hasIris=${prepared.scan.hasIris})`);
    return prepared.scan;
  }

  /** Back-compatible one-shot open used by non-transactional callers/tests. */
  async open(root: string): Promise<IrisScanResult> {
    return this.activatePrepared(await this.prepareOpen(root));
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingChanges = [];
    this.pendingPromptChanges = [];
    if (this.watcher) {
      await this.watcher.close().catch(() => {});
      this.watcher = null;
    }
    this.projectRoot = null;
    this.projectPromptBaseline = '';
    this.projectPromptConflicts = [];
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
      const stat = await fs.lstat(abs);
      if (!stat.isFile() || stat.isSymbolicLink()) return { dataUrl: null, error: 'read-failed' };
      this.resolveInside(root, await fs.realpath(abs));
      if (stat.size > MAX_IMAGE_BYTES) return { dataUrl: null, error: 'too-large' };
      const bytes = await fs.readFile(abs);
      return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, error: null };
    } catch {
      return { dataUrl: null, error: 'read-failed' };
    }
  }

  async listAssets(docPath: string): Promise<AssetInventory> {
    return this.assetManager.list(this.requireRoot(), docPath);
  }

  async importAsset(payload: AssetImportPayload): Promise<AssetImportResult> {
    return this.assetManager.import(this.requireRoot(), payload);
  }

  async trashAsset(
    docPath: string,
    assetPath: string,
    trashItem: (absolutePath: string) => Promise<void>,
  ): Promise<{ path: string }> {
    return this.assetManager.trash(this.requireRoot(), docPath, assetPath, trashItem);
  }

  async adoptAsset(docPath: string, source: string): Promise<AssetImportResult> {
    return this.assetManager.adopt(this.requireRoot(), docPath, source);
  }

  /** Compare-and-swap a document. expectedContent is the renderer's baseline;
   * null is the explicit user-authorized overwrite path. Identical content is
   * a no-op so false dirty state can never perturb mtime ordering. */
  async writeDoc(
    relPath: string,
    content: string,
    expectedContent: string | null,
  ): Promise<{ path: string }> {
    const root = this.requireRoot();
    if (typeof content !== 'string' || (expectedContent !== null && typeof expectedContent !== 'string')) {
      throw new ProjectError('InvalidPayload', 'content and expectedContent must be strings (or null)');
    }
    const abs = this.resolveInside(root, relPath);
    let current: string;
    try {
      current = await fs.readFile(abs, 'utf8');
    } catch (err) {
      throw new ProjectError(
        'WriteConflict',
        `cannot compare ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (current === content) return { path: relPath };
    if (expectedContent !== null && current !== expectedContent) {
      throw new ProjectError('WriteConflict', `${relPath} changed since the editor baseline`);
    }

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

    // No body H1: the typed header owns the title (frontmatter 不进正文编辑器);
    // a scaffolded heading would render the title twice.
    const content = docSkeleton(type, title);

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
   * software prompt's "do not delete issues" binds agent write-back, not the
   * user). Scoped to markdown files under .iris/ — the only files Iris owns.
   */
  async deleteDoc(
    relPath: string,
    trashItem: (absolutePath: string) => Promise<void> = (path) =>
      fs.rm(path, { recursive: true }),
  ): Promise<{ path: string; assetCount: number }> {
    const root = this.requireRoot();
    if (!/\.md$/i.test(relPath) || !relPath.replace(/\\/g, '/').startsWith('.iris/')) {
      throw new ProjectError('InvalidPayload', `refusing to delete non-iris file: ${relPath}`);
    }
    const abs = this.resolveInside(root, relPath);
    const companionRel = this.assetManager.companionPath(relPath);
    const companionAbs = this.resolveInside(root, companionRel);
    const assetCount = await this.assetManager.managedFileCount(root, relPath);
    const companionStat = await fs.lstat(companionAbs).catch(() => null);
    if (companionStat && (!companionStat.isDirectory() || companionStat.isSymbolicLink())) {
      throw new ProjectError('InvalidPayload', `unsafe companion directory: ${companionRel}`);
    }

    // Stage the aggregate in its current filesystem before trashing it. If
    // the OS trash operation fails, both names can be restored in place.
    const stage = join(dirname(abs), `.iris-delete-${process.pid}-${randomUUID()}`);
    const stagedDoc = join(stage, basename(abs));
    const stagedAssets = join(stage, basename(companionAbs));
    let docMoved = false;
    let assetsMoved = false;
    try {
      await fs.mkdir(stage);
      await fs.rename(abs, stagedDoc);
      docMoved = true;
      if (companionStat) {
        await fs.rename(companionAbs, stagedAssets);
        assetsMoved = true;
      }
      await trashItem(stage);
    } catch (err) {
      if (assetsMoved) await fs.rename(stagedAssets, companionAbs).catch(() => {});
      if (docMoved) await fs.rename(stagedDoc, abs).catch(() => {});
      await fs.rmdir(stage).catch(() => {});
      throw new ProjectError(
        'WriteFailed',
        `cannot delete ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { path: relPath, assetCount };
  }

  /**
   * Idempotent protocol scaffold (project.init / cold start §4 冷启动):
   * ensure the four typed folders and write/refresh the
   * `<iris-software>` block in AGENTS.md plus any existing vendor entry files
   * (§3A maintains vendor entries; never creates absent ones). Touching the
   * project root requires explicit user confirmation in the UI — the single
   * sanctioned exception to 尊重边界.
   *
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

    // AGENTS.md — the standard entry Iris owns and always writes.
    const agentsAbs = join(root, 'AGENTS.md');
    const a = await syncEntryFile(agentsAbs);
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
      const { action } = await syncEntryFile(join(root, rel));
      vendorEntries.push({ path: rel, action });
    }

    logger.info(
      'project',
      `init: folders=[${createdFolders.join(', ')}] agents=${agentsMd} vendor=[${vendorEntries.map((v) => `${v.path}:${v.action}`).join(', ')}]`,
    );
    const result: ProjectInitResult = {
      createdFolders,
      agentsMd,
      vendorEntries,
      foreignEntries,
    };
    return result;
  }

  // ── prompt governance (issue: iris软件提示词治理) ────────────────────

  /**
   * Read-only governance snapshot for the open project: the `<iris-software>`
   * block state in AGENTS.md (always listed) + any existing vendor entries,
   * and the synchronized project-prompt state.
   */
  async softwarePromptState(): Promise<SoftwarePromptState> {
    const root = this.requireRoot();
    const entries: SoftwareEntryStatus[] = [await this.entryStatus(root, 'AGENTS.md', true)];
    for (const rel of FOREIGN_AGENT_ENTRIES) {
      if (await exists(join(root, rel))) entries.push(await this.entryStatus(root, rel, false));
    }

    return {
      entries,
      project: {
        state: this.projectPromptConflicts.length > 0
          ? 'conflict'
          : this.projectPromptBaseline === ''
            ? 'missing'
            : 'synced',
        text: this.projectPromptBaseline,
        conflicts: this.projectPromptConflicts,
      },
    };
  }

  /**
   * Read-only content view of the governed prompt layers + the assembled
   * injection an agent receives — the text behind the freshness badges, for the
   * settings 软件提示词 viewer. Pure read (never writes).
   */
  async contextPreview(): Promise<ContextPreview> {
    return assembleContextPreview(this.requireRoot());
  }

  private async entryStatus(
    root: string,
    rel: string,
    isStandard: boolean,
  ): Promise<SoftwareEntryStatus> {
    try {
      const text = await fs.readFile(this.resolveInside(root, rel), 'utf8');
      const { state } = classifySoftwareBlock(text);
      return { path: rel, isStandard, state };
    } catch {
      return { path: rel, isStandard, state: 'no-entry' };
    }
  }

  /**
   * Write/refresh the `<iris-software>` block in one entry file (user-confirmed
   * in the settings UI). AGENTS.md may be
   * created; a vendor entry is refused if it does not already exist (Iris never
   * grows a vendor zoo). Returns the fresh state for the UI to re-render.
   */
  async syncSoftwareEntry(relPath: string): Promise<SoftwarePromptState> {
    const root = this.requireRoot();
    if (!WRITABLE_ENTRIES.includes(relPath)) {
      throw new ProjectError('InvalidPayload', `refusing to write the block into ${relPath}`);
    }
    const abs = this.resolveInside(root, relPath);
    if (relPath !== 'AGENTS.md' && !(await exists(abs))) {
      throw new ProjectError('InvalidPayload', `vendor entry ${relPath} does not exist (Iris does not create it)`);
    }
    await syncEntryFile(abs);
    return this.softwarePromptState();
  }

  /** User-edited project prompt becomes the new disk truth and is mirrored. */
  async syncProjectPrompt(text: string): Promise<SoftwarePromptState> {
    if (typeof text !== 'string') {
      throw new ProjectError('InvalidPayload', 'project prompt must be a string');
    }
    const root = this.requireRoot();
    const normalized = normalizePromptBody(text);
    await this.writeProjectPrompt(root, normalized);
    this.projectPromptBaseline = normalized;
    this.projectPromptConflicts = [];
    this.emit('promptChanged');
    return this.softwarePromptState();
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

  private async existingEntryPaths(root: string): Promise<string[]> {
    const paths: string[] = [];
    for (const rel of WRITABLE_ENTRIES) {
      if (await exists(join(root, rel))) paths.push(rel);
    }
    return paths;
  }

  private async readProjectPrompt(
    root: string,
    rel: string,
  ): Promise<{ path: string; text: string; hasBlock: boolean }> {
    try {
      const source = await fs.readFile(this.resolveInside(root, rel), 'utf8');
      const block = parseProjectBlock(source);
      return { path: rel, text: block?.body ?? '', hasBlock: block !== null };
    } catch {
      return { path: rel, text: '', hasBlock: false };
    }
  }

  private async reconcileProjectPromptInitial(root: string): Promise<void> {
    const paths = await this.existingEntryPaths(root);
    const snapshots = await Promise.all(paths.map((rel) => this.readProjectPrompt(root, rel)));
    const bodies = [...new Set(snapshots.filter((item) => item.hasBlock && item.text !== '').map((item) => item.text))];

    if (bodies.length > 1) {
      this.projectPromptBaseline = '';
      this.projectPromptConflicts = snapshots
        .filter((item) => item.hasBlock && item.text !== '')
        .map(({ path, text }) => ({ path, text }));
      this.emit('promptChanged');
      return;
    }

    this.projectPromptBaseline = bodies[0] ?? '';
    this.projectPromptConflicts = [];
    if (bodies.length === 1 || snapshots.some((item) => item.hasBlock)) {
      await this.writeProjectPrompt(root, this.projectPromptBaseline);
    }
    this.emit('promptChanged');
  }

  private async reconcileProjectPromptChanges(
    root: string,
    changes: FsIrisChangedEvent['changes'],
  ): Promise<void> {
    if (this.projectRoot !== root) return;
    if (this.projectPromptConflicts.length > 0) {
      await this.reconcileProjectPromptInitial(root);
      return;
    }

    const candidates: ProjectPromptConflict[] = [];
    const changedPaths = [...new Set(changes.filter((change) => change.kind === 'add' || change.kind === 'change').map((change) => change.path))];
    for (const rel of changedPaths) {
      const snapshot = await this.readProjectPrompt(root, rel);
      // Creating an unrelated vendor entry without a project block is not a
      // request to clear the current project prompt.
      const wasAdded = changes.some((change) => change.path === rel && change.kind === 'add');
      if (wasAdded && !snapshot.hasBlock) continue;
      if (snapshot.text !== this.projectPromptBaseline) {
        candidates.push({ path: rel, text: snapshot.text });
      }
    }

    const distinct = [...new Set(candidates.map((item) => item.text))];
    if (distinct.length === 0) return;
    if (distinct.length > 1) {
      this.projectPromptConflicts = candidates;
      this.emit('promptChanged');
      return;
    }

    const nextBaseline = distinct[0] ?? '';
    await this.writeProjectPrompt(root, nextBaseline);
    if (this.projectRoot !== root) return;
    this.projectPromptBaseline = nextBaseline;
    this.projectPromptConflicts = [];
    this.emit('promptChanged');
  }

  private async writeProjectPrompt(root: string, body: string): Promise<void> {
    const targets = new Set(await this.existingEntryPaths(root));
    if (body !== '') targets.add('AGENTS.md');
    for (const rel of targets) {
      const abs = this.resolveInside(root, rel);
      let source = '';
      try {
        source = await fs.readFile(abs, 'utf8');
      } catch {
        // A non-empty prompt may create the standard entry below.
      }
      const result = upsertProjectBlock(source, body === '' ? null : body);
      if (result.action === 'unchanged') continue;
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, result.text, 'utf8');
      logger.info('project', `project prompt ${result.action} in ${abs}`);
    }
  }

  private startWatcher(root: string): void {
    const irisAbs = join(root, '.iris');
    const entryPaths = WRITABLE_ENTRIES.map((rel) => join(root, rel));
    this.watcher = chokidar.watch([irisAbs, ...entryPaths], {
      ignoreInitial: true,
      // Editors/agents writing files produce write bursts; wait for quiet.
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
    });

    const push = (kind: FsIrisChangedEvent['changes'][number]['kind']) => (path: string) => {
      // A callback already queued by an old watcher must never be relabeled as
      // the newly active project after a switch.
      if (this.projectRoot !== root) return;
      const rel = path.slice(root.length + 1).split(sep).join('/');
      if ((WRITABLE_ENTRIES as readonly string[]).includes(rel)) {
        this.pendingPromptChanges.push({ kind, path: rel });
      } else {
        this.pendingChanges.push({ kind, path: rel });
      }
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
      if (!this.projectRoot) return;
      const root = this.projectRoot;
      const irisChanges = this.pendingChanges;
      const promptChanges = this.pendingPromptChanges;
      this.pendingChanges = [];
      this.pendingPromptChanges = [];
      if (irisChanges.length > 0) {
        this.emit('irisChanged', { projectRoot: root, changes: irisChanges } satisfies FsIrisChangedEvent);
      }
      if (promptChanges.length > 0) {
        this.promptReconcileTail = this.promptReconcileTail
          .then(() => this.reconcileProjectPromptChanges(root, promptChanges))
          .catch((err) => logger.warn('project', 'project prompt reconciliation failed', err));
      }
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
