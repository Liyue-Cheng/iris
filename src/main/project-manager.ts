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
  ProjectPromptEntryStatus,
  ProjectPromptConflict,
  ProjectToolbarAction,
  RawTreeNode,
  SoftwareEntryStatus,
  SoftwarePromptState,
} from '@shared/types';
import { DOC_TYPES } from '@shared/types';
import { slugify } from '@shared/markdown-utils';
import { parseFrontmatter, scanProject, scanRawTree } from './iris-scanner';
import { FOREIGN_AGENT_ENTRIES } from './iris-templates';
import {
  assembleContextPreview,
  removePromptEntryBlocks,
  syncEntryFile,
  syncPromptEntryFile,
} from './agent-injection';
import {
  classifySoftwareBlock,
  buildSoftwareBlock,
  docSkeleton,
  normalizePromptBody,
  parseProjectBlocks,
} from './software-prompt';
import { logger } from './logger';
import { AssetManager } from './asset-manager';
import { mainT } from './i18n';
import { writeFileAtomic } from './atomic-write';
import {
  MISSING_PROJECT_SETTINGS_REVISION,
  readProjectSettings,
  initializeProjectSettingsFile,
  SUPPORTED_PROJECT_ENTRY_PATHS,
  updateProjectEntries,
  updateProjectPrompt,
  updateProjectToolbar,
  type ProjectSettingsFileSnapshot,
} from './project-settings';

/** Entry files Iris may write the `<iris-software>` block into. */
const WRITABLE_ENTRIES: readonly string[] = SUPPORTED_PROJECT_ENTRY_PATHS;

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
  private projectPromptConflicts: ProjectPromptConflict[] = [];
  private readonly projectPromptWriteErrors = new Map<string, string>();
  private projectSettingsError: string | null = null;

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
      throw new ProjectError('NotADirectory', mainT('error.projectCannotAccess', { path: abs }));
    }
    if (!stat.isDirectory()) {
      throw new ProjectError('NotADirectory', mainT('error.projectNotDirectory', { path: canonicalRoot }));
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
      if (prepared.scan.hasIris) await this.initializeProjectSettings(prepared.root);
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
    this.projectPromptConflicts = [];
    this.projectPromptWriteErrors.clear();
    this.projectSettingsError = null;
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
        mainT('error.projectReadFailed', {
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
        }),
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

  /** Read the active project's App settings. Missing files project as defaults. */
  projectSettings(): Promise<ProjectSettingsFileSnapshot> {
    return readProjectSettings(this.requireRoot());
  }

  /** Replace only toolbar.actions, preserving future/unknown project settings. */
  updateProjectToolbar(
    actions: readonly ProjectToolbarAction[],
    expectedRevision: string,
  ): Promise<ProjectSettingsFileSnapshot> {
    if (this.projectPromptConflicts.length > 0) {
      throw new ProjectError('WriteConflict', 'Resolve the project prompt migration conflict first');
    }
    return updateProjectToolbar(this.requireRoot(), actions, expectedRevision);
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
      throw new ProjectError('InvalidPayload', mainT('error.projectWritePayload'));
    }
    const abs = this.resolveInside(root, relPath);
    let current: string;
    try {
      current = await fs.readFile(abs, 'utf8');
    } catch (err) {
      throw new ProjectError(
        'WriteConflict',
        mainT('error.projectCompareFailed', {
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    if (current === content) return { path: relPath };
    if (expectedContent !== null && current !== expectedContent) {
      throw new ProjectError('WriteConflict', mainT('error.projectChanged', { path: relPath }));
    }

    try {
      await writeFileAtomic(abs, content);
    } catch (err) {
      throw new ProjectError(
        'WriteFailed',
        mainT('error.projectWriteFailed', {
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
        }),
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
      throw new ProjectError('InvalidPayload', mainT('error.projectCreatePayload'));
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
        mainT('error.projectCreateFailed', {
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
        }),
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
      throw new ProjectError('InvalidPayload', mainT('error.projectDeleteRefused', { path: relPath }));
    }
    const abs = this.resolveInside(root, relPath);
    const companionRel = this.assetManager.companionPath(relPath);
    const companionAbs = this.resolveInside(root, companionRel);
    const assetCount = await this.assetManager.managedFileCount(root, relPath);
    const companionStat = await fs.lstat(companionAbs).catch(() => null);
    if (companionStat && (!companionStat.isDirectory() || companionStat.isSymbolicLink())) {
      throw new ProjectError(
        'InvalidPayload',
        mainT('error.projectUnsafeCompanion', { path: companionRel }),
      );
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
        mainT('error.projectDeleteFailed', {
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
        }),
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

    await this.initializeProjectSettings(root);
    const settings = await readProjectSettings(root);
    const participants = settings.settings.agentContext.entries;

    // A migration conflict has no project-layer truth yet. Preserve every
    // candidate and initialize only the software layer until the user chooses.
    const syncOne = (rel: string) =>
      this.projectPromptConflicts.length > 0
        ? syncEntryFile(join(root, rel))
        : syncPromptEntryFile(join(root, rel), settings.settings.prompts.project);

    const a = await syncOne('AGENTS.md');
    const agentsMd: ProjectInitResult['agentsMd'] = !a.existed
      ? 'created'
      : a.action === 'unchanged'
        ? 'already-has-section'
        : a.action === 'updated'
          ? 'updated'
          : 'appended';

    // Only the explicit project list participates. Initialization recreates a
    // missing selected entry, but never enrolls an unrelated vendor file.
    const vendorEntries: ProjectInitResult['vendorEntries'] = [];
    const foreignEntries: string[] = [];
    for (const rel of FOREIGN_AGENT_ENTRIES) {
      if (await exists(join(root, rel))) foreignEntries.push(rel);
      if (participants.includes(rel)) {
        const { action } = await syncOne(rel);
        vendorEntries.push({ path: rel, action });
      }
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
    const settings = await readProjectSettings(root);
    const participants = settings.settings.agentContext.entries;
    const entries = await Promise.all(
      participants.map((rel) => this.entryStatus(root, rel, rel === 'AGENTS.md')),
    );
    const desired = settings.settings.prompts.project;
    const projectEntries = await this.projectPromptEntryStatuses(root, desired, participants);
    const hasPartial = projectEntries.some(
      (entry) => entry.state === 'duplicate' || entry.state === 'write-failed',
    );
    const hasDrift = projectEntries.some(
      (entry) => entry.state === 'drifted' || entry.state === 'missing',
    );
    const error = settings.error ?? this.projectSettingsError;
    return {
      softwareText: buildSoftwareBlock().trimEnd(),
      entries,
      availableEntries: WRITABLE_ENTRIES.filter((entry) => !participants.includes(entry)),
      project: {
        state: this.projectPromptConflicts.length > 0
          ? 'conflict'
          : error
            ? 'invalid-settings'
            : hasPartial
              ? 'partial'
              : hasDrift
                ? 'drifted'
                : desired === ''
                  ? 'missing'
                  : 'synced',
        text: desired,
        conflicts: this.projectPromptConflicts,
        entries: projectEntries,
        error,
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

  /** Reconcile both managed layers in one participating entry file. */
  async syncSoftwareEntry(relPath: string): Promise<SoftwarePromptState> {
    const root = this.requireRoot();
    const settings = await readProjectSettings(root);
    if (!settings.exists || settings.error) {
      throw new ProjectError('WriteFailed', settings.error ?? 'Project settings is missing');
    }
    if (!settings.settings.agentContext.entries.includes(relPath)) {
      throw new ProjectError('InvalidPayload', `Entry is not participating: ${relPath}`);
    }
    await this.syncPromptEntry(root, relPath, settings.settings.prompts.project);
    this.emit('promptChanged');
    return this.softwarePromptState();
  }

  /** Reconcile every participating entry from the two canonical sources. */
  async syncAllPromptEntries(): Promise<SoftwarePromptState> {
    const root = this.requireRoot();
    const settings = await readProjectSettings(root);
    if (!settings.exists || settings.error) {
      throw new ProjectError('WriteFailed', settings.error ?? 'Project settings is missing');
    }
    for (const rel of settings.settings.agentContext.entries) {
      await this.syncPromptEntry(root, rel, settings.settings.prompts.project);
    }
    this.emit('promptChanged');
    return this.softwarePromptState();
  }

  /** Enroll an entry in project settings first, then materialize both layers. */
  async addPromptEntry(
    relPath: string,
    expectedRevision: string,
  ): Promise<{ snapshot: ProjectSettingsFileSnapshot; prompt: SoftwarePromptState['project'] }> {
    if (!WRITABLE_ENTRIES.includes(relPath)) {
      throw new ProjectError('InvalidPayload', `Unsupported prompt entry: ${relPath}`);
    }
    const root = this.requireRoot();
    const current = await readProjectSettings(root);
    if (!current.exists || current.error) {
      throw new ProjectError('WriteFailed', current.error ?? 'Project settings is missing');
    }
    const snapshot = await updateProjectEntries(
      root,
      [...current.settings.agentContext.entries, relPath],
      expectedRevision,
    );
    await this.syncPromptEntry(root, relPath, snapshot.settings.prompts.project);
    this.emit('promptChanged');
    return { snapshot, prompt: (await this.softwarePromptState()).project };
  }

  /** Remove both blocks before removing the entry from the desired target set. */
  async removePromptEntry(
    relPath: string,
    expectedRevision: string,
  ): Promise<{ snapshot: ProjectSettingsFileSnapshot; prompt: SoftwarePromptState['project'] }> {
    if (relPath === 'AGENTS.md') {
      throw new ProjectError('InvalidPayload', 'AGENTS.md is the required Iris entry');
    }
    const root = this.requireRoot();
    const current = await readProjectSettings(root);
    if (!current.exists || current.error) {
      throw new ProjectError('WriteFailed', current.error ?? 'Project settings is missing');
    }
    if (!current.settings.agentContext.entries.includes(relPath)) {
      throw new ProjectError('InvalidPayload', `Entry is not participating: ${relPath}`);
    }
    await removePromptEntryBlocks(this.resolveInside(root, relPath));
    let snapshot: ProjectSettingsFileSnapshot;
    try {
      snapshot = await updateProjectEntries(
        root,
        current.settings.agentContext.entries.filter((entry) => entry !== relPath),
        expectedRevision,
      );
    } catch (err) {
      await this.syncPromptEntry(root, relPath, current.settings.prompts.project).catch(() => {});
      throw err;
    }
    this.projectPromptWriteErrors.delete(relPath);
    this.emit('promptChanged');
    return { snapshot, prompt: (await this.softwarePromptState()).project };
  }

  /** Commit the canonical JSON value with CAS, then project it to entry files. */
  async syncProjectPrompt(
    text: string,
    expectedRevision: string,
  ): Promise<{ snapshot: ProjectSettingsFileSnapshot; prompt: SoftwarePromptState['project'] }> {
    if (typeof text !== 'string') {
      throw new ProjectError('InvalidPayload', mainT('error.projectPromptPayload'));
    }
    const root = this.requireRoot();
    const normalized = normalizePromptBody(text);
    const current = await readProjectSettings(root);
    const snapshot = !current.exists && this.projectPromptConflicts.length > 0
      ? await initializeProjectSettingsFile(
          root,
          normalized,
          ['AGENTS.md', ...(await this.existingEntryPaths(root)).filter((path) => path !== 'AGENTS.md')],
          expectedRevision,
        )
      : await updateProjectPrompt(root, normalized, expectedRevision);
    this.projectPromptConflicts = [];
    this.projectSettingsError = null;
    for (const rel of snapshot.settings.agentContext.entries) {
      await this.syncPromptEntry(root, rel, normalized);
    }
    this.emit('promptChanged');
    return { snapshot, prompt: (await this.softwarePromptState()).project };
  }

  /** Back-compatible alias: a repair now restores both managed layers. */
  async restoreProjectPromptEntry(relPath: string): Promise<SoftwarePromptState> {
    return this.syncSoftwareEntry(relPath);
  }

  /** Sessions only start after settings validation/migration and projection. */
  async assertProjectSettingsReady(): Promise<void> {
    const root = this.requireRoot();
    if (!(await exists(join(root, '.iris')))) return;
    const settings = await readProjectSettings(root);
    if (this.projectPromptConflicts.length > 0) {
      throw new ProjectError('WriteConflict', 'Resolve the project settings migration conflict before starting a terminal');
    }
    if (!settings.exists || settings.error) {
      throw new ProjectError('ReadFailed', settings.error ?? 'Project settings is missing');
    }
    const state = await this.softwarePromptState();
    const softwareReady = state.entries.every((entry) => entry.state === 'ok');
    const projectReady = state.project.state === 'synced' || state.project.state === 'missing';
    if (!softwareReady || !projectReady) {
      throw new ProjectError(
        'WriteFailed',
        'Synchronize the participating agent entry files before starting a terminal',
      );
    }
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
      throw new ProjectError('InvalidPayload', mainT('error.workspaceInvalidName', { name }));
    }
    if ((DOC_TYPES as readonly string[]).includes(trimmed)) {
      throw new ProjectError(
        'InvalidPayload',
        mainT('error.workspaceReservedName', { name: trimmed }),
      );
    }
    const wsAbs = this.resolveInside(root, `${parentPath}/${trimmed}`);
    if (await exists(wsAbs)) {
      throw new ProjectError(
        'WriteFailed',
        mainT('error.workspaceExists', { path: `${parentPath}/${trimmed}` }),
      );
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
    if (!this.projectRoot) throw new ProjectError('NoProject', mainT('error.projectNoProject'));
    return this.projectRoot;
  }

  /** Path-traversal guard: resolved path must stay under the project root. */
  private resolveInside(root: string, relPath: string): string {
    const abs = normalize(resolve(root, relPath));
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new ProjectError('OutsideProject', mainT('error.projectOutsideRoot', { path: relPath }));
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
  ): Promise<{ path: string; blocks: ReturnType<typeof parseProjectBlocks> }> {
    try {
      const source = await fs.readFile(this.resolveInside(root, rel), 'utf8');
      return { path: rel, blocks: parseProjectBlocks(source) };
    } catch {
      return { path: rel, blocks: [] };
    }
  }

  private async initializeProjectSettings(root: string): Promise<void> {
    const settings = await readProjectSettings(root);
    this.projectSettingsError = settings.error;
    this.projectPromptConflicts = [];
    this.projectPromptWriteErrors.clear();

    if (settings.exists) {
      if (!settings.error && !settings.entryListExplicit) {
        const entries = [
          'AGENTS.md',
          ...(await this.existingEntryPaths(root)).filter((path) => path !== 'AGENTS.md'),
        ];
        await updateProjectEntries(root, entries, settings.revision);
      }
      this.emit('promptChanged');
      return;
    }

    const paths = await this.existingEntryPaths(root);
    const snapshots = await Promise.all(paths.map((rel) => this.readProjectPrompt(root, rel)));
    const candidates = snapshots.flatMap(({ path, blocks }) =>
      blocks.filter((block) => block.body !== '').map((block) => ({ path, text: block.body })),
    );
    const bodies = [...new Set(candidates.map((item) => item.text))];
    const hasDuplicate = snapshots.some((item) => item.blocks.length > 1);

    if (bodies.length > 1 || hasDuplicate) {
      this.projectPromptConflicts = candidates;
      this.emit('promptChanged');
      return;
    }

    await initializeProjectSettingsFile(
      root,
      bodies[0] ?? '',
      ['AGENTS.md', ...paths.filter((path) => path !== 'AGENTS.md')],
      MISSING_PROJECT_SETTINGS_REVISION,
    );
    this.emit('promptChanged');
  }

  private async reconcileProjectPromptChanges(
    root: string,
    changes: FsIrisChangedEvent['changes'],
  ): Promise<void> {
    if (this.projectRoot !== root) return;
    for (const change of changes) this.projectPromptWriteErrors.delete(change.path);
    const settings = await readProjectSettings(root);
    this.projectSettingsError = settings.error;
    this.emit('promptChanged');
  }

  private async reconcileProjectSettingsChange(root: string): Promise<void> {
    if (this.projectRoot !== root) return;
    const settings = await readProjectSettings(root);
    this.projectSettingsError = settings.error ?? (!settings.exists ? 'Project settings is missing' : null);
    if (settings.exists && !settings.error) {
      this.projectPromptConflicts = [];
    }
    this.emit('promptChanged');
  }

  private async syncPromptEntry(root: string, rel: string, body: string): Promise<void> {
    if (!WRITABLE_ENTRIES.includes(rel)) {
      throw new ProjectError('InvalidPayload', `Unsupported prompt entry: ${rel}`);
    }
    const abs = this.resolveInside(root, rel);
    try {
      await syncPromptEntryFile(abs, body);
      this.projectPromptWriteErrors.delete(rel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.projectPromptWriteErrors.set(rel, message);
      logger.warn('project', `prompt projection failed for ${abs}`, err);
    }
  }

  private async projectPromptEntryStatuses(
    root: string,
    desired: string,
    participants: readonly string[],
  ): Promise<ProjectPromptEntryStatus[]> {
    const statuses: ProjectPromptEntryStatus[] = [];
    for (const path of participants) {
      const isStandard = path === 'AGENTS.md';
      let source: string | null = null;
      try {
        source = await fs.readFile(this.resolveInside(root, path), 'utf8');
      } catch {
        // A participating entry remains visible when its file is missing.
      }
      const blocks = source === null ? [] : parseProjectBlocks(source);
      const writeError = this.projectPromptWriteErrors.get(path) ?? null;
      let state: ProjectPromptEntryStatus['state'];
      if (writeError) state = 'write-failed';
      else if (blocks.length > 1) state = 'duplicate';
      else if (desired === '' && blocks.length === 0) state = 'synced';
      else if (blocks.length === 0) state = 'missing';
      else if (blocks[0]?.body === desired && !blocks[0].hasAttributes) state = 'synced';
      else state = 'drifted';
      statuses.push({
        path,
        isStandard,
        state,
        text: blocks[0]?.body ?? null,
        error: writeError ?? (blocks.length > 1 ? 'Multiple <iris-project> blocks' : null),
      });
    }
    return statuses;
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
      const settingsChanged = irisChanges.some(
        (change) => change.path === '.iris/settings.json',
      );
      if (promptChanges.length > 0 || settingsChanged) {
        this.promptReconcileTail = this.promptReconcileTail
          .then(async () => {
            if (settingsChanged) await this.reconcileProjectSettingsChange(root);
            if (promptChanges.length > 0) {
              await this.reconcileProjectPromptChanges(root, promptChanges);
            }
          })
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
