import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { AppError } from '@shared/app-error';
import type {
  GitBranchInfo,
  GitErrorCode,
  GitSnapshot,
  GitSnapshotError,
} from '@shared/types';
import { mainT } from './i18n';
import { logger } from './logger';
import { parseGitPorcelainV1Z } from './git-porcelain';
import { defaultProcessTreeKiller } from './terminal/process-tree';

interface RepositoryIdentity {
  projectRoot: string;
  worktreeRoot: string;
  gitDir: string;
  commonDir: string;
  id: string;
}

interface GitCommandOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

interface ProcessFailure extends Error {
  code?: string | number;
  signal?: NodeJS.Signals;
  stderr?: string;
  timedOut?: boolean;
}

const STATUS_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;
const SWITCH_TIMEOUT_MS = 60_000;
const COMMIT_TIMEOUT_MS = 5 * 60_000;
const STATUS_MAX_BUFFER = 32 * 1024 * 1024;
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;
const GIT_PROBE_INTERVAL_MS = 2_000;
const GIT_PROBE_JITTER_MS = 250;
const GIT_PROBE_RETRY_MAX_MS = 30_000;
const GIT_PROBE_MAX_CONCURRENCY = 2;
const GIT_METADATA_TARGET_LIMIT = 256;
const repositoryMutationTails = new Map<string, Promise<void>>();

async function serializeRepositoryMutation<T>(
  repositoryId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = repositoryMutationTails.get(repositoryId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const tail = previous.catch(() => {}).then(() => current);
  repositoryMutationTails.set(repositoryId, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (repositoryMutationTails.get(repositoryId) === tail) repositoryMutationTails.delete(repositoryId);
  }
}

export class GitError extends AppError {
  constructor(
    code: string,
    message: string,
    retryable = false,
  ) {
    super('git', code, message, { retryable });
    this.name = 'GitError';
  }
}

function emptySnapshot(
  projectRoot: string | null,
  revision: number,
  error: GitSnapshotError | null = null,
): GitSnapshot {
  return {
    available: false,
    projectRoot,
    root: null,
    gitDir: null,
    commonDir: null,
    repositoryId: null,
    revision,
    stale: false,
    branch: null,
    head: null,
    detached: false,
    ahead: 0,
    behind: 0,
    branches: [],
    groups: { merge: [], index: [], workingTree: [], untracked: [] },
    error,
  };
}

function pathFromGit(value: string, cwd: string): string {
  return normalize(isAbsolute(value) ? value : resolve(cwd, value));
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const failure = error as ProcessFailure;
  return failure.stderr?.trim() || error.message;
}

function classifyFailure(error: unknown, operation: string): GitSnapshotError {
  const failure = error as ProcessFailure;
  const text = errorText(error);
  const lower = text.toLowerCase();
  let code: GitErrorCode = 'CommandFailed';
  let retryable = false;

  if (failure.timedOut) {
    code = 'Timeout';
    retryable = true;
  } else if (failure.code === 'ENOENT') {
    code = 'GitUnavailable';
  } else if (lower.includes('not a git repository')) {
    code = 'NotRepository';
  } else if (lower.includes('dubious ownership') || lower.includes('safe.directory')) {
    code = 'UnsafeRepository';
  } else if (lower.includes('index.lock') || lower.includes('another git process')) {
    code = 'RepositoryLocked';
    retryable = true;
  } else if (lower.includes('permission denied') || lower.includes('access is denied')) {
    code = 'PermissionDenied';
    retryable = true;
  } else if (lower.includes('gpg failed') || lower.includes('failed to sign')) {
    code = 'SigningFailed';
    retryable = true;
  } else if (operation === 'commit' && (
    lower.includes('author identity unknown') ||
    lower.includes('please tell me who you are') ||
    lower.includes('unable to auto-detect email address')
  )) {
    code = 'ConfigurationError';
  } else if (operation === 'commit' && (
    lower.includes('nothing to commit') || lower.includes('no changes added to commit')
  )) {
    code = 'NoStagedChanges';
    retryable = true;
  } else if (operation === 'commit') {
    code = lower.includes('hook') ? 'HookFailed' : 'CommitRejected';
    retryable = true;
  } else if (operation === 'switch-branch') {
    code = 'BranchConflict';
    retryable = true;
  }

  const message = failure.timedOut
    ? `Git ${operation} timed out.`
    : text || `Git ${operation} failed.`;
  return { code, message, retryable };
}

function runGit(
  args: string[],
  cwd: string,
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? COMMAND_MAX_BUFFER;
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd ?? cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANG: 'C' },
      detached: process.platform !== 'win32',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timedOut = false;

    const terminateTree = (): void => {
      const pid = child.pid;
      if (pid === undefined) {
        child.kill();
        return;
      }
      const windowsKiller = defaultProcessTreeKiller();
      if (windowsKiller) {
        void windowsKiller(pid).catch(() => { child.kill(); });
        return;
      }
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        child.kill();
      }
    };

    const fail = (error: ProcessFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree();
    }, timeoutMs);

    child.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBuffer) {
        const error = new Error(`Git output exceeded ${maxBuffer} bytes.`) as ProcessFailure;
        error.code = 'MAX_BUFFER';
        terminateTree();
        fail(error);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBuffer) {
        const error = new Error(`Git output exceeded ${maxBuffer} bytes.`) as ProcessFailure;
        error.code = 'MAX_BUFFER';
        terminateTree();
        fail(error);
        return;
      }
      stderr.push(chunk);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (timedOut || code !== 0) {
        const error = new Error(stderrText.trim() || `git exited with code ${String(code)}`) as ProcessFailure;
        if (code !== null) error.code = code;
        if (signal !== null) error.signal = signal;
        error.stderr = stderrText;
        error.timedOut = timedOut;
        reject(error);
        return;
      }
      settled = true;
      resolvePromise({ stdout: stdoutText, stderr: stderrText });
    });
    child.stdin.on('error', () => { /* command exit owns the useful error */ });
    child.stdin.end(options.input);
  });
}

export function gitMetadataWatchTargets(
  repository: Pick<RepositoryIdentity, 'worktreeRoot' | 'gitDir' | 'commonDir'>,
): string[] {
  let currentRef: string | null = null;
  try {
    const head = readFileSync(join(repository.gitDir, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: refs/') && !head.includes('..')) {
      const candidate = normalize(join(repository.commonDir, head.slice('ref: '.length)));
      const rel = relative(repository.commonDir, candidate);
      if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) currentRef = candidate;
    }
  } catch {
    // The HEAD file can be absent while a repository is being initialized.
  }
  const targets = Array.from(new Set([
    join(repository.gitDir, 'index'),
    join(repository.gitDir, 'index.lock'),
    join(repository.gitDir, 'HEAD'),
    join(repository.commonDir, 'packed-refs'),
    ...(currentRef ? [currentRef] : []),
  ]));
  if (targets.length > GIT_METADATA_TARGET_LIMIT) {
    logger.warn('git', `metadata watcher target limit exceeded for ${repository.worktreeRoot}`);
    return targets.slice(0, GIT_METADATA_TARGET_LIMIT);
  }
  return targets;
}

export function shouldInvalidateGitWatchEvent(event: string, path: string): boolean {
  return !path.endsWith(`${sep}index.lock`) || event === 'unlink';
}

async function repositoryFingerprint(repository: RepositoryIdentity): Promise<string> {
  const status = await runGit([
    '-c', 'core.quotepath=false',
    'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all',
  ], repository.worktreeRoot, {
    timeoutMs: STATUS_TIMEOUT_MS,
    maxBuffer: STATUS_MAX_BUFFER,
  });
  const refs = await runGit([
    'for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads',
  ], repository.worktreeRoot, {
    timeoutMs: STATUS_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  return createHash('sha256')
    .update(status.stdout)
    .update('\0')
    .update(refs.stdout)
    .digest('hex');
}

interface GitWatchListener {
  changed: () => void;
  healthChanged: (state: 'healthy' | 'degraded', error?: unknown) => void;
}

interface GitWatchEntry {
  repository: RepositoryIdentity;
  listeners: Set<GitWatchListener>;
  watcher: FSWatcher | null;
  watcherClosePromise: Promise<void> | null;
  watcherReady: boolean;
  watcherRetryTimer: NodeJS.Timeout | null;
  watcherRetryAttempt: number;
  probeTimer: NodeJS.Timeout | null;
  probePromise: Promise<void> | null;
  probeRetryAttempt: number;
  fingerprint: string | null;
  closed: boolean;
}

class GitWatchCoordinator {
  private readonly entries = new Map<string, GitWatchEntry>();
  private activeProbes = 0;

  async subscribe(
    repository: RepositoryIdentity,
    listener: GitWatchListener,
  ): Promise<() => Promise<void>> {
    let entry = this.entries.get(repository.id);
    if (!entry) {
      entry = {
        repository,
        listeners: new Set(),
        watcher: null,
        watcherClosePromise: null,
        watcherReady: false,
        watcherRetryTimer: null,
        watcherRetryAttempt: 0,
        probeTimer: null,
        probePromise: null,
        probeRetryAttempt: 0,
        fingerprint: null,
        closed: false,
      };
      this.entries.set(repository.id, entry);
      this.startMetadataWatcher(entry);
    }
    entry.listeners.add(listener);
    if (entry.watcherReady && entry.fingerprint !== null) listener.healthChanged('healthy');
    void this.runProbe(entry);
    return () => this.unsubscribe(entry!, listener);
  }

  private async unsubscribe(entry: GitWatchEntry, listener: GitWatchListener): Promise<void> {
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0 || this.entries.get(entry.repository.id) !== entry) return;
    this.entries.delete(entry.repository.id);
    entry.closed = true;
    if (entry.probeTimer) clearTimeout(entry.probeTimer);
    if (entry.watcherRetryTimer) clearTimeout(entry.watcherRetryTimer);
    entry.probeTimer = null;
    entry.watcherRetryTimer = null;
    const watcher = entry.watcher;
    entry.watcher = null;
    await Promise.all([
      watcher?.close().catch(() => {}),
      entry.watcherClosePromise?.catch(() => {}),
      entry.probePromise?.catch(() => {}),
    ]);
  }

  private startMetadataWatcher(entry: GitWatchEntry): void {
    if (entry.closed || this.entries.get(entry.repository.id) !== entry) return;
    entry.watcherReady = false;
    const watcher = chokidar.watch(gitMetadataWatchTargets(entry.repository), {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    });
    entry.watcher = watcher;
    watcher
      .on('all', (event, path) => {
        if (!shouldInvalidateGitWatchEvent(event, path)) return;
        this.notifyChanged(entry);
        this.scheduleProbe(entry, 100);
        if (normalize(path) === join(entry.repository.gitDir, 'HEAD')) {
          this.restartMetadataWatcher(entry, watcher);
        }
      })
      .on('ready', () => {
        if (entry.closed || entry.watcher !== watcher) return;
        entry.watcherReady = true;
        entry.watcherRetryAttempt = 0;
        if (entry.fingerprint !== null) this.notifyHealth(entry, 'healthy');
      })
      .on('error', (error) => this.handleWatcherError(entry, watcher, error));
  }

  private restartMetadataWatcher(entry: GitWatchEntry, watcher: FSWatcher): void {
    if (entry.closed || entry.watcher !== watcher) return;
    entry.watcher = null;
    const closing = watcher.close().catch(() => {});
    entry.watcherClosePromise = closing;
    void closing.then(() => {
      if (entry.watcherClosePromise === closing) entry.watcherClosePromise = null;
      this.startMetadataWatcher(entry);
    });
  }

  private handleWatcherError(entry: GitWatchEntry, watcher: FSWatcher, error: unknown): void {
    if (entry.closed || entry.watcher !== watcher) return;
    logger.warn('git', `metadata watcher error for ${entry.repository.worktreeRoot}`, error);
    entry.watcherReady = false;
    this.notifyHealth(entry, 'degraded', error);
    entry.watcher = null;
    void watcher.close().catch(() => {});
    if (entry.watcherRetryTimer) return;
    const delay = Math.min(
      GIT_PROBE_RETRY_MAX_MS,
      1_000 * (2 ** entry.watcherRetryAttempt),
    );
    entry.watcherRetryAttempt += 1;
    entry.watcherRetryTimer = setTimeout(() => {
      entry.watcherRetryTimer = null;
      this.startMetadataWatcher(entry);
    }, delay);
  }

  private scheduleProbe(entry: GitWatchEntry, delay?: number): void {
    if (entry.closed || this.entries.get(entry.repository.id) !== entry) return;
    if (entry.probeTimer) clearTimeout(entry.probeTimer);
    const jitter = Math.floor(Math.random() * GIT_PROBE_JITTER_MS);
    entry.probeTimer = setTimeout(() => {
      entry.probeTimer = null;
      void this.runProbe(entry);
    }, delay ?? GIT_PROBE_INTERVAL_MS + jitter);
  }

  private async runProbe(entry: GitWatchEntry): Promise<void> {
    if (entry.closed || this.entries.get(entry.repository.id) !== entry) return;
    if (entry.probePromise) return entry.probePromise;
    if (this.activeProbes >= GIT_PROBE_MAX_CONCURRENCY) {
      this.scheduleProbe(entry, 250);
      return;
    }
    const probe = this.performProbe(entry);
    entry.probePromise = probe;
    await probe.finally(() => {
      if (entry.probePromise === probe) entry.probePromise = null;
    });
  }

  private async performProbe(entry: GitWatchEntry): Promise<void> {
    this.activeProbes += 1;
    let nextDelay: number | undefined;
    try {
      const fingerprint = await repositoryFingerprint(entry.repository);
      if (entry.closed || this.entries.get(entry.repository.id) !== entry) return;
      const changed = entry.fingerprint !== null && entry.fingerprint !== fingerprint;
      const recovered = entry.probeRetryAttempt > 0;
      const initialized = entry.fingerprint === null;
      entry.fingerprint = fingerprint;
      entry.probeRetryAttempt = 0;
      if (entry.watcherReady && (initialized || recovered)) this.notifyHealth(entry, 'healthy');
      if (changed) this.notifyChanged(entry);
    } catch (error) {
      if (entry.closed || this.entries.get(entry.repository.id) !== entry) return;
      logger.warn('git', `status probe failed for ${entry.repository.worktreeRoot}`, error);
      this.notifyHealth(entry, 'degraded', error);
      nextDelay = Math.min(
        GIT_PROBE_RETRY_MAX_MS,
        1_000 * (2 ** entry.probeRetryAttempt),
      );
      entry.probeRetryAttempt += 1;
    } finally {
      this.activeProbes -= 1;
      if (!entry.closed && this.entries.get(entry.repository.id) === entry) {
        this.scheduleProbe(entry, nextDelay);
      }
    }
  }

  private notifyChanged(entry: GitWatchEntry): void {
    for (const listener of entry.listeners) listener.changed();
  }

  private notifyHealth(
    entry: GitWatchEntry,
    state: 'healthy' | 'degraded',
    error?: unknown,
  ): void {
    for (const listener of entry.listeners) listener.healthChanged(state, error);
  }
}

const gitWatchCoordinator = new GitWatchCoordinator();

/** Per-window Git projection. Watchers only invalidate; status is authoritative. */
export class GitManager extends EventEmitter {
  private projectRoot: string | null = null;
  private repository: RepositoryIdentity | null = null;
  private timer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private signalGeneration = 0;
  private signalSubscription: { repositoryId: string; unsubscribe: () => Promise<void> } | null = null;
  private revision = 0;
  private lastSnapshot: GitSnapshot | null = null;

  async open(projectRoot: string): Promise<void> {
    await this.close();
    this.projectRoot = normalize(resolve(projectRoot));
    await this.refreshRepositoryIdentity();
    await this.syncWatchSubscription();
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.timer = null;
    this.discoveryTimer = null;
    this.signalGeneration += 1;
    const subscription = this.signalSubscription;
    this.signalSubscription = null;
    await subscription?.unsubscribe().catch(() => {});
    this.projectRoot = null;
    this.repository = null;
    this.lastSnapshot = null;
    this.revision = 0;
  }

  private async discoverRepository(projectRoot: string): Promise<RepositoryIdentity> {
    const worktree = (await runGit(['rev-parse', '--show-toplevel'], projectRoot)).stdout.trim();
    const gitDir = (await runGit(['rev-parse', '--absolute-git-dir'], projectRoot)).stdout.trim();
    const commonRaw = (await runGit(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      projectRoot,
    )).stdout.trim();
    const worktreeRoot = pathFromGit(worktree, projectRoot);
    const absoluteGitDir = pathFromGit(gitDir, projectRoot);
    const commonDir = pathFromGit(commonRaw, projectRoot);
    return {
      projectRoot,
      worktreeRoot,
      gitDir: absoluteGitDir,
      commonDir,
      id: `${worktreeRoot}\0${absoluteGitDir}`,
    };
  }

  private async refreshRepositoryIdentity(): Promise<void> {
    if (!this.projectRoot) return;
    try {
      const next = await this.discoverRepository(this.projectRoot);
      if (this.repository?.id !== next.id) {
        this.repository = next;
        this.lastSnapshot = null;
      }
    } catch (error) {
      if (classifyFailure(error, 'discover').code === 'NotRepository') {
        this.repository = null;
        this.lastSnapshot = null;
        return;
      }
      throw error;
    }
  }

  private invalidate(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit('changed');
    }, 150);
  }

  private async syncWatchSubscription(): Promise<void> {
    const repository = this.repository;
    if (repository && this.signalSubscription?.repositoryId === repository.id) return;
    this.signalGeneration += 1;
    const generation = this.signalGeneration;
    const previous = this.signalSubscription;
    this.signalSubscription = null;
    await previous?.unsubscribe().catch(() => {});
    if (generation !== this.signalGeneration || !this.projectRoot) return;
    if (!repository) {
      this.scheduleRepositoryDiscovery();
      return;
    }
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = null;
    const unsubscribe = await gitWatchCoordinator.subscribe(repository, {
      changed: () => {
        if (generation === this.signalGeneration) this.invalidate();
      },
      healthChanged: (state, error) => {
        if (generation !== this.signalGeneration) return;
        this.emit('healthChanged', { domain: 'git-watcher', state, ...(error === undefined ? {} : { error }) });
      },
    });
    if (generation !== this.signalGeneration || !this.projectRoot) {
      await unsubscribe();
      return;
    }
    this.signalSubscription = { repositoryId: repository.id, unsubscribe };
  }

  private scheduleRepositoryDiscovery(): void {
    if (!this.projectRoot || this.repository || this.discoveryTimer) return;
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      void this.discoverOpenedRepository();
    }, GIT_PROBE_INTERVAL_MS);
  }

  private async discoverOpenedRepository(): Promise<void> {
    if (!this.projectRoot || this.repository) return;
    try {
      await this.refreshRepositoryIdentity();
      await this.syncWatchSubscription();
      if (this.repository) this.invalidate();
    } catch (error) {
      logger.warn('git', `repository discovery probe failed for ${this.projectRoot}`, error);
      this.emit('healthChanged', { domain: 'git-watcher', state: 'degraded', error });
    } finally {
      this.scheduleRepositoryDiscovery();
    }
  }

  private repositoryOrThrow(): RepositoryIdentity {
    if (!this.projectRoot) throw new GitError('NoProject', mainT('error.gitNoProject'));
    if (!this.repository) throw new GitError('NotRepository', 'The project is not in a Git repository.');
    return this.repository;
  }

  private pathspec(paths: string[]): { paths: string[]; input: string } {
    const repository = this.repositoryOrThrow();
    if (paths.length === 0) throw new GitError('NoPaths', mainT('error.gitSelectFiles'));
    const validated = paths.map((path) => {
      if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
        throw new GitError('InvalidPath', mainT('error.gitInvalidPath'));
      }
      const absolute = resolve(repository.worktreeRoot, path);
      const rel = relative(repository.worktreeRoot, absolute);
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new GitError('OutsideRepository', mainT('error.gitPathOutsideProject'));
      }
      return rel.split(sep).join('/');
    });
    return { paths: validated, input: `${validated.join('\0')}\0` };
  }

  private async command(
    operation: string,
    args: string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    const repository = this.repositoryOrThrow();
    try {
      return await runGit(args, repository.worktreeRoot, options);
    } catch (error) {
      const classified = classifyFailure(error, operation);
      throw new GitError(classified.code, classified.message, classified.retryable);
    }
  }

  private async mutateRepository(operation: () => Promise<void>): Promise<void> {
    const repository = this.repositoryOrThrow();
    await serializeRepositoryMutation(repository.id, operation);
  }

  async status(): Promise<GitSnapshot> {
    const requestRevision = ++this.revision;
    if (!this.projectRoot) return emptySnapshot(null, requestRevision);
    try {
      await this.refreshRepositoryIdentity();
      await this.syncWatchSubscription();
      const repository = this.repositoryOrThrow();
      await (repositoryMutationTails.get(repository.id) ?? Promise.resolve()).catch(() => {});
      const { stdout } = await this.command('status', [
        '-c', 'core.quotepath=false',
        'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all',
      ], { timeoutMs: STATUS_TIMEOUT_MS, maxBuffer: STATUS_MAX_BUFFER });
      const parsed = parseGitPorcelainV1Z(stdout);
      const branches = await this.branches();
      let head: string | null = null;
      try {
        head = (await this.command('head', ['rev-parse', '--verify', 'HEAD'])).stdout.trim() || null;
      } catch (error) {
        if (!(error instanceof GitError) || error.code !== 'CommandFailed') throw error;
      }
      const snapshot: GitSnapshot = {
        available: true,
        projectRoot: repository.projectRoot,
        root: repository.worktreeRoot,
        gitDir: repository.gitDir,
        commonDir: repository.commonDir,
        repositoryId: repository.id,
        revision: requestRevision,
        stale: false,
        branch: parsed.branch,
        head,
        detached: parsed.detached,
        ahead: parsed.ahead,
        behind: parsed.behind,
        branches,
        groups: parsed.groups,
        error: null,
      };
      if (!this.lastSnapshot || snapshot.revision >= this.lastSnapshot.revision) {
        this.lastSnapshot = snapshot;
      }
      return snapshot;
    } catch (error) {
      const classified = error instanceof GitError
        ? { code: error.code as GitErrorCode, message: error.message, retryable: error.retryable }
        : classifyFailure(error, 'status');
      if (this.lastSnapshot && this.lastSnapshot.repositoryId === this.repository?.id) {
        return { ...this.lastSnapshot, revision: requestRevision, stale: true, error: classified };
      }
      return emptySnapshot(this.projectRoot, requestRevision, classified);
    }
  }

  async stage(paths: string[]): Promise<void> {
    const pathspec = this.pathspec(paths);
    await this.mutateRepository(async () => {
      await this.command('stage', [
        '--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul', '--',
      ], { input: pathspec.input, timeoutMs: WRITE_TIMEOUT_MS });
    });
    this.invalidate();
  }

  async unstage(paths: string[]): Promise<void> {
    const pathspec = this.pathspec(paths);
    await this.mutateRepository(async () => {
      const hasHead = (await this.command('has-head', ['rev-parse', '--verify', 'HEAD'])
        .then(() => true, () => false));
      const args = hasHead
        ? ['--literal-pathspecs', 'reset', '--pathspec-from-file=-', '--pathspec-file-nul', 'HEAD', '--']
        : ['--literal-pathspecs', 'rm', '--cached', '-r', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul', '--'];
      await this.command('unstage', args, { input: pathspec.input, timeoutMs: WRITE_TIMEOUT_MS });
    });
    this.invalidate();
  }

  async switchBranch(branch: string): Promise<void> {
    if (typeof branch !== 'string' || branch.trim() === '' || branch.includes('\0')) {
      throw new GitError('InvalidBranch', mainT('error.gitInvalidBranch'));
    }
    await this.mutateRepository(async () => {
      await this.command('switch-branch', ['switch', '--', branch], { timeoutMs: SWITCH_TIMEOUT_MS });
    });
    this.invalidate();
  }

  async commit(message: string): Promise<void> {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new GitError('EmptyCommitMessage', mainT('error.gitCommitMessageRequired'));
    }
    await this.mutateRepository(async () => {
      await this.command('commit', ['commit', '--cleanup=whitespace', '--file=-'], {
        input: message.trim(),
        timeoutMs: COMMIT_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
      });
    });
    this.invalidate();
  }

  private async branches(): Promise<GitBranchInfo[]> {
    const { stdout } = await this.command('branches', [
      'for-each-ref', '--format=%(refname:short)%00%(HEAD)', 'refs/heads',
    ]);
    return stdout.split(/\r?\n/).flatMap((line): GitBranchInfo[] => {
      if (!line) return [];
      const separator = line.indexOf('\0');
      if (separator < 1) return [];
      return [{ name: line.slice(0, separator), current: line.slice(separator + 1) === '*' }];
    });
  }
}
