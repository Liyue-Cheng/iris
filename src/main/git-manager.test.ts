import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitManager,
  shouldIgnoreGitWatchPath,
  shouldInvalidateGitWatchEvent,
} from './git-manager';

const execFileP = promisify(execFile);
let tempRoot: string;
let repository: string;
let manager: GitManager;

async function git(args: string[], cwd = repository): Promise<string> {
  return (await execFileP('git', [
    '-c', 'core.hooksPath=',
    '-c', 'commit.gpgSign=false',
    ...args,
  ], { cwd, windowsHide: true })).stdout;
}

async function initRepository(): Promise<void> {
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Iris Test']);
  await git(['config', 'user.email', 'iris@example.test']);
  await git(['config', 'commit.gpgSign', 'false']);
}

async function commitFile(path: string, content: string): Promise<void> {
  const absolute = join(repository, path);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content, 'utf8');
  await git(['add', '--', path]);
  await git(['commit', '-m', `add ${path}`]);
}

async function waitForChange(label: string, action: () => Promise<void>): Promise<void> {
  const changed = new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Git watcher did not invalidate for ${label}`)), 5_000);
    manager.once('changed', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
  await action();
  await changed;
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'iris-git-manager-'));
  repository = join(tempRoot, 'repository');
  await mkdir(repository);
  manager = new GitManager();
});

afterEach(async () => {
  await manager.close();
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 3 });
});

describe('GitManager integration', () => {
  it('returns a classified result outside a repository', async () => {
    await manager.open(repository);
    const snapshot = await manager.status();
    expect(snapshot).toMatchObject({ available: false, stale: false });
    expect(snapshot.error?.code).toBe('NotRepository');
  });

  it('discovers a repository initialized after the project was opened', async () => {
    await manager.open(repository);
    expect((await manager.status()).available).toBe(false);
    await initRepository();
    await writeFile(join(repository, 'late.txt'), 'late', 'utf8');

    const snapshot = await manager.status();
    expect(snapshot).toMatchObject({ available: true, root: repository, branch: 'main' });
    expect(snapshot.groups.untracked[0]?.path).toBe('late.txt');
  });

  it('supports stage, unstage and the first commit in an unborn repository', async () => {
    await initRepository();
    await writeFile(join(repository, 'first file.txt'), 'first', 'utf8');
    await manager.open(repository);

    let snapshot = await manager.status();
    expect(snapshot).toMatchObject({ available: true, branch: 'main', head: null });
    expect(snapshot.groups.untracked[0]?.path).toBe('first file.txt');

    await manager.stage(['first file.txt']);
    expect((await manager.status()).groups.index[0]?.status).toBe('A ');
    await manager.unstage(['first file.txt']);
    expect((await manager.status()).groups.untracked[0]?.path).toBe('first file.txt');

    await manager.stage(['first file.txt']);
    await manager.commit('initial commit\n\n# release note\nbody');
    snapshot = await manager.status();
    expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.groups.index).toEqual([]);
    expect(await git(['show', '-s', '--format=%B', 'HEAD'])).toContain('# release note');
  });

  it('reports detached HEAD without inventing a branch name', async () => {
    await initRepository();
    await commitFile('tracked.txt', 'base');
    await git(['checkout', '--detach', 'HEAD']);
    await manager.open(repository);

    const snapshot = await manager.status();
    expect(snapshot).toMatchObject({ branch: null, detached: true });
    expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('projects a file in both index and working tree and keeps rename paths intact', async () => {
    await initRepository();
    await commitFile('old name.txt', 'base');
    await writeFile(join(repository, 'old name.txt'), 'staged', 'utf8');
    await git(['add', '--', 'old name.txt']);
    await writeFile(join(repository, 'old name.txt'), 'working', 'utf8');
    await manager.open(repository);

    let snapshot = await manager.status();
    expect(snapshot.groups.index[0]?.path).toBe('old name.txt');
    expect(snapshot.groups.workingTree[0]?.path).toBe('old name.txt');

    await git(['reset', '--hard', 'HEAD']);
    await git(['mv', 'old name.txt', 'new name.txt']);
    snapshot = await manager.status();
    expect(snapshot.groups.index[0]).toMatchObject({
      path: 'new name.txt',
      originalPath: 'old name.txt',
      status: 'R ',
    });
    await manager.unstage(['new name.txt', 'old name.txt']);
    snapshot = await manager.status();
    expect(snapshot.groups.index).toEqual([]);
    expect(snapshot.groups.workingTree.map((entry) => entry.path)).toEqual(['old name.txt']);
    expect(snapshot.groups.untracked.map((entry) => entry.path)).toEqual(['new name.txt']);
  });

  it('handles special paths through NUL-delimited stdin pathspecs', async () => {
    await initRepository();
    const paths = [
      '-leading.txt',
      'space name.txt',
      '目录.txt',
      ...(process.platform === 'win32' ? [] : [':(glob)magic*.txt']),
    ];
    await Promise.all(paths.map((path) => writeFile(join(repository, path), path, 'utf8')));
    await manager.open(repository);

    await manager.stage(paths);
    expect((await manager.status()).groups.index.map((entry) => entry.path).sort()).toEqual(paths.sort());
    await manager.unstage(paths);
    expect((await manager.status()).groups.untracked).toHaveLength(paths.length);
  });

  it('stages enough paths to exceed the Windows command-line limit', async () => {
    await initRepository();
    const paths = Array.from({ length: 240 }, (_, index) =>
      `bulk/${String(index).padStart(3, '0')}-${'long-name-'.repeat(12)}.txt`);
    await mkdir(join(repository, 'bulk'));
    await Promise.all(paths.map((path) => writeFile(join(repository, path), path, 'utf8')));
    await manager.open(repository);

    await manager.stage(paths);
    expect((await manager.status()).groups.index).toHaveLength(paths.length);
    await manager.unstage(paths);
    expect((await manager.status()).groups.index).toEqual([]);
  }, 30_000);

  it('invalidates for deep worktree changes and external index updates', async () => {
    await initRepository();
    await commitFile('src/deep/nested/tracked.txt', 'base');
    const ready = new Promise<void>((resolvePromise) => {
      manager.once('healthChanged', () => resolvePromise());
    });
    await manager.open(repository);
    await ready;

    await waitForChange('deep worktree file', () => writeFile(
      join(repository, 'src', 'deep', 'nested', 'tracked.txt'),
      'changed',
      'utf8',
    ));
    await waitForChange('external index update', async () => {
      await git(['add', '--', 'src/deep/nested/tracked.txt']);
    });
    expect((await manager.status()).groups.index[0]?.path).toBe('src/deep/nested/tracked.txt');
  }, 15_000);

  it('uses the full worktree when the Iris project is a repository subdirectory', async () => {
    await initRepository();
    await commitFile('outside.txt', 'base');
    const projectRoot = join(repository, 'nested', 'project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(repository, 'outside.txt'), 'changed', 'utf8');
    await manager.open(projectRoot);

    const snapshot = await manager.status();
    expect(snapshot.root).toBe(repository);
    expect(snapshot.projectRoot).toBe(projectRoot);
    expect(snapshot.groups.workingTree[0]?.path).toBe('outside.txt');
    await manager.stage(['outside.txt']);
    expect((await manager.status()).groups.index[0]?.path).toBe('outside.txt');
  });

  it('discovers linked worktree metadata and switches existing local branches', async () => {
    await initRepository();
    await commitFile('tracked.txt', 'base');
    await git(['branch', 'topic']);
    const linked = join(tempRoot, 'linked');
    await git(['worktree', 'add', linked, 'topic']);
    await manager.open(linked);

    let snapshot = await manager.status();
    expect(snapshot.branch).toBe('topic');
    expect(snapshot.gitDir).not.toBe(snapshot.commonDir);
    await expect(manager.switchBranch('main')).rejects.toMatchObject({
      code: 'BranchConflict',
      retryable: true,
    });
    snapshot = await manager.status();
    expect(snapshot.branch).toBe('topic');
    expect(snapshot.error).toBeNull();
  });

  it('switches successfully to an available local branch', async () => {
    await initRepository();
    await commitFile('tracked.txt', 'base');
    await git(['branch', 'topic']);
    await manager.open(repository);

    await manager.switchBranch('topic');
    expect((await manager.status()).branch).toBe('topic');
  });

  it('invalidates linked worktrees when their external index changes', async () => {
    await initRepository();
    await commitFile('tracked.txt', 'base');
    await git(['branch', 'topic']);
    const linked = join(tempRoot, 'linked-watch');
    await git(['worktree', 'add', linked, 'topic']);
    const ready = new Promise<void>((resolvePromise) => {
      manager.once('healthChanged', () => resolvePromise());
    });
    await manager.open(linked);
    await ready;
    await writeFile(join(linked, 'tracked.txt'), 'linked change', 'utf8');

    await waitForChange('linked worktree index update', async () => {
      await git(['add', '--', 'tracked.txt'], linked);
    });
    expect((await manager.status()).groups.index[0]?.path).toBe('tracked.txt');
  }, 15_000);

  it('preserves the last valid snapshot when a refresh temporarily fails', async () => {
    await initRepository();
    await commitFile('tracked.txt', 'base');
    await manager.open(repository);
    const valid = await manager.status();
    await writeFile(join(repository, '.git', 'index.lock'), 'locked', 'utf8');

    await expect(manager.stage(['tracked.txt'])).rejects.toMatchObject({
      code: 'RepositoryLocked',
      retryable: true,
    });
    const afterFailure = await manager.status();
    expect(afterFailure.repositoryId).toBe(valid.repositoryId);
    expect(afterFailure.available).toBe(true);
  });

  it('returns the last valid snapshot as stale when the index is temporarily unreadable', async () => {
    await initRepository();
    await commitFile('tracked.txt', 'base');
    await manager.open(repository);
    const valid = await manager.status();
    const index = join(repository, '.git', 'index');
    const backup = join(repository, '.git', 'index.backup');
    await rename(index, backup);
    await mkdir(index);
    try {
      const stale = await manager.status();
      expect(stale).toMatchObject({
        available: true,
        repositoryId: valid.repositoryId,
        stale: true,
      });
      expect(stale.error).not.toBeNull();
    } finally {
      await rm(index, { recursive: true, force: true });
      await rename(backup, index);
    }
    expect((await manager.status()).stale).toBe(false);
  });

  it('projects a real merge conflict without duplicating it into other groups', async () => {
    await initRepository();
    await commitFile('conflict.txt', 'base\n');
    await git(['checkout', '-b', 'topic']);
    await writeFile(join(repository, 'conflict.txt'), 'topic\n', 'utf8');
    await git(['commit', '-am', 'topic']);
    await git(['checkout', 'main']);
    await writeFile(join(repository, 'conflict.txt'), 'main\n', 'utf8');
    await git(['commit', '-am', 'main']);
    await git(['merge', 'topic']).catch(() => undefined);
    await manager.open(repository);

    const snapshot = await manager.status();
    expect(snapshot.groups.merge).toEqual([{
      path: 'conflict.txt',
      status: 'UU',
      group: 'merge',
    }]);
    expect(snapshot.groups.index).toEqual([]);
    expect(snapshot.groups.workingTree).toEqual([]);
  });

  it('projects a dirty submodule as a working-tree change', async () => {
    await initRepository();
    const child = join(tempRoot, 'child-repository');
    await mkdir(child);
    await git(['init', '--initial-branch=main'], child);
    await git(['config', 'user.name', 'Iris Test'], child);
    await git(['config', 'user.email', 'iris@example.test'], child);
    await writeFile(join(child, 'child.txt'), 'base', 'utf8');
    await git(['add', '--', 'child.txt'], child);
    await git(['commit', '-m', 'child base'], child);
    await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'vendor/child']);
    await git(['commit', '-m', 'add submodule']);
    await writeFile(join(repository, 'vendor', 'child', 'child.txt'), 'dirty', 'utf8');
    await manager.open(repository);

    const snapshot = await manager.status();
    expect(snapshot.groups.workingTree).toContainEqual({
      path: 'vendor/child',
      status: ' M',
      group: 'workingTree',
    });
  }, 30_000);

  it('classifies missing commit identity without losing the staged state', async () => {
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.name', '']);
    await git(['config', 'user.email', '']);
    await writeFile(join(repository, 'unconfigured.txt'), 'content', 'utf8');
    await manager.open(repository);
    await manager.stage(['unconfigured.txt']);

    await expect(manager.commit('cannot identify author')).rejects.toMatchObject({
      code: 'ConfigurationError',
      retryable: false,
    });
    expect((await manager.status()).groups.index[0]?.path).toBe('unconfigured.txt');
  });

  it('surfaces hook failures without creating a commit', async () => {
    await initRepository();
    await writeFile(join(repository, 'hooked.txt'), 'content', 'utf8');
    await git(['add', '--', 'hooked.txt']);
    const hook = join(repository, '.git', 'hooks', 'commit-msg');
    await writeFile(hook, '#!/bin/sh\necho rejected-by-hook >&2\nexit 1\n', 'utf8');
    await chmod(hook, 0o755);
    await git(['config', 'core.hooksPath', join(repository, '.git', 'hooks')]);
    await manager.open(repository);

    await expect(manager.commit('should fail')).rejects.toMatchObject({
      code: 'HookFailed',
      retryable: true,
    });
    expect((await manager.status()).head).toBeNull();
  });

  it('rejects paths outside the worktree', async () => {
    await initRepository();
    await manager.open(repository);
    await expect(manager.stage(['../outside.txt'])).rejects.toMatchObject({
      code: 'OutsideRepository',
    });
  });

  it('serializes index writes from two managers opened on the same repository', async () => {
    await initRepository();
    const secondManager = new GitManager();
    await Promise.all([
      writeFile(join(repository, 'first.txt'), 'first', 'utf8'),
      writeFile(join(repository, 'second.txt'), 'second', 'utf8'),
    ]);
    await manager.open(repository);
    await secondManager.open(repository);
    try {
      await Promise.all([
        manager.stage(['first.txt']),
        secondManager.stage(['second.txt']),
      ]);
      expect((await manager.status()).groups.index.map((entry) => entry.path).sort()).toEqual([
        'first.txt',
        'second.txt',
      ]);
    } finally {
      await secondManager.close();
    }
  });
});

describe('Git watcher filters', () => {
  const repository = {
    worktreeRoot: resolve('watcher-repository'),
    gitDir: resolve('watcher-repository', '.git'),
    commonDir: resolve('watcher-repository', '.git'),
  };

  it('keeps authoritative metadata and ignores noisy Git internals', () => {
    expect(shouldIgnoreGitWatchPath(repository, join(repository.gitDir, 'index'))).toBe(false);
    expect(shouldIgnoreGitWatchPath(repository, join(repository.gitDir, 'HEAD'))).toBe(false);
    expect(shouldIgnoreGitWatchPath(repository, join(repository.gitDir, 'packed-refs'))).toBe(false);
    expect(shouldIgnoreGitWatchPath(repository, join(repository.gitDir, 'refs', 'heads', 'main'))).toBe(false);
    expect(shouldIgnoreGitWatchPath(repository, join(repository.gitDir, 'objects', 'ab', 'object'))).toBe(true);
    expect(shouldIgnoreGitWatchPath(repository, join(repository.gitDir, 'fsmonitor--daemon', 'cookie'))).toBe(true);
    expect(shouldIgnoreGitWatchPath(repository, join(repository.worktreeRoot, 'src', 'deep', 'file.ts'))).toBe(false);
  });

  it('waits for index.lock removal before invalidating', () => {
    const lock = join(repository.gitDir, 'index.lock');
    expect(shouldInvalidateGitWatchEvent('add', lock)).toBe(false);
    expect(shouldInvalidateGitWatchEvent('change', lock)).toBe(false);
    expect(shouldInvalidateGitWatchEvent('unlink', lock)).toBe(true);
  });
});
