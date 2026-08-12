import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
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

export function shouldIgnoreGitWatchPath(
  repository: Pick<RepositoryIdentity, 'worktreeRoot' | 'gitDir' | 'commonDir'>,
  path: string,
): boolean {
  const normalized = normalize(path);
  const rel = relative(repository.worktreeRoot, normalized);
  const insideWorktree = rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
  const insideGitDir = normalized === repository.gitDir || normalized.startsWith(`${repository.gitDir}${sep}`);
  const insideCommonDir = normalized === repository.commonDir || normalized.startsWith(`${repository.commonDir}${sep}`);
  if (insideGitDir || insideCommonDir) {
    const metadataRoots = [repository.gitDir, repository.commonDir];
    const metadataRelative = metadataRoots.flatMap((root) => {
      const candidate = relative(root, normalized);
      return candidate === '' || (!candidate.startsWith(`..${sep}`) && candidate !== '..')
        ? [candidate]
        : [];
    });
    return !metadataRelative.some((candidate) =>
      candidate === '' ||
      candidate === 'HEAD' ||
      candidate === 'index' ||
      candidate === 'index.lock' ||
      candidate === 'packed-refs' ||
      candidate === 'refs' ||
      candidate.startsWith(`refs${sep}`),
    );
  }
  return insideWorktree && rel.split(sep).includes('.git');
}

export function shouldInvalidateGitWatchEvent(event: string, path: string): boolean {
  return !path.endsWith(`${sep}index.lock`) || event === 'unlink';
}

/** Per-window Git projection. Watchers only invalidate; status is authoritative. */
export class GitManager extends EventEmitter {
  private projectRoot: string | null = null;
  private repository: RepositoryIdentity | null = null;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watcherRetryTimer: NodeJS.Timeout | null = null;
  private watcherRetryAttempt = 0;
  private watcherGeneration = 0;
  private revision = 0;
  private lastSnapshot: GitSnapshot | null = null;

  async open(projectRoot: string): Promise<void> {
    await this.close();
    this.projectRoot = normalize(resolve(projectRoot));
    await this.refreshRepositoryIdentity();
    this.watcherGeneration += 1;
    this.startWatcher(this.watcherGeneration);
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.watcherRetryTimer) clearTimeout(this.watcherRetryTimer);
    this.timer = null;
    this.watcherRetryTimer = null;
    this.watcherRetryAttempt = 0;
    this.watcherGeneration += 1;
    await this.watcher?.close().catch(() => {});
    this.watcher = null;
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

  private watchTargets(): string[] {
    if (!this.projectRoot) return [];
    if (!this.repository) return [this.projectRoot];
    const { worktreeRoot, gitDir, commonDir } = this.repository;
    return Array.from(new Set([worktreeRoot, gitDir, commonDir])).filter((target) => {
      if (target === worktreeRoot) return true;
      const rel = relative(worktreeRoot, target);
      return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    });
  }

  private startWatcher(generation: number): void {
    const targets = this.watchTargets();
    if (targets.length === 0) return;
    const repository = this.repository;
    const watcher = chokidar.watch(targets, {
      ignored: (path) => repository ? shouldIgnoreGitWatchPath(repository, path) : false,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    });
    this.watcher = watcher;
    watcher
      .on('all', (event, path) => {
        if (!shouldInvalidateGitWatchEvent(event, path)) return;
        this.invalidate();
      })
      .on('ready', () => {
        if (this.watcherGeneration !== generation) return;
        this.watcherRetryAttempt = 0;
        this.emit('healthChanged', { domain: 'git-watcher', state: 'healthy' });
      })
      .on('error', (error) => this.handleWatcherError(generation, error));
  }

  private handleWatcherError(generation: number, error: unknown): void {
    if (this.watcherGeneration !== generation) return;
    logger.warn('git', `watcher error for ${this.projectRoot ?? 'closed project'}`, error);
    this.emit('healthChanged', { domain: 'git-watcher', state: 'degraded', error });
    if (this.watcherRetryTimer) return;
    const delay = Math.min(30_000, 1_000 * (2 ** this.watcherRetryAttempt));
    this.watcherRetryAttempt += 1;
    this.watcherRetryTimer = setTimeout(() => {
      this.watcherRetryTimer = null;
      void this.rebuildWatcher(generation);
    }, delay);
  }

  private async rebuildWatcher(generation: number): Promise<void> {
    if (this.watcherGeneration !== generation) return;
    const previous = this.watcher;
    this.watcher = null;
    await previous?.close().catch(() => {});
    if (this.watcherGeneration !== generation) return;
    try {
      this.startWatcher(generation);
    } catch (error) {
      this.handleWatcherError(generation, error);
    }
  }

  private invalidate(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit('changed');
    }, 150);
  }

  private async restartWatcherIfIdentityChanged(previousId: string | null): Promise<void> {
    if (this.repository?.id === previousId) return;
    this.watcherGeneration += 1;
    const generation = this.watcherGeneration;
    const previous = this.watcher;
    this.watcher = null;
    await previous?.close().catch(() => {});
    this.startWatcher(generation);
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
    const previousId = this.repository?.id ?? null;
    try {
      await this.refreshRepositoryIdentity();
      await this.restartWatcherIfIdentityChanged(previousId);
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
