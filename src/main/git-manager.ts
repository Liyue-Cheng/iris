import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, resolve, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { GitBranchInfo, GitResource, GitResourceGroup, GitSnapshot } from '@shared/types';

const execFileP = promisify(execFile);
function empty(root: string | null, error: string | null = null): GitSnapshot {
  return { available: false, root, branch: null, head: null, detached: false, ahead: 0, behind: 0, branches: [], groups: { merge: [], index: [], workingTree: [], untracked: [] }, error };
}

/** Per-window Git projection. The watcher only invalidates the projection; it
 * never parses filesystem events into Git state. */
export class GitManager extends EventEmitter {
  private root: string | null = null;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  async open(root: string): Promise<void> {
    await this.close();
    this.root = root;
    this.watcher = chokidar.watch(root, { ignored: (p) => p.includes(`${sep}.git${sep}`) && (p.endsWith(`${sep}index.lock`) || p.includes(`${sep}fsmonitor--daemon`)), ignoreInitial: true, depth: 2 });
    this.watcher.on('all', () => this.invalidate());
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.watcher?.close().catch(() => {});
    this.watcher = null;
    this.root = null;
  }

  private invalidate(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.emit('changed'); }, 150);
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (!this.root) throw new Error('没有打开项目');
    return execFileP('git', args, { cwd: this.root, timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  }

  private paths(paths: string[]): string[] {
    if (!this.root || paths.length === 0) throw new Error('请选择至少一个文件');
    return paths.map((p) => {
      if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) throw new Error('无效 Git 文件路径');
      const abs = resolve(this.root!, p);
      const rel = relative(this.root!, abs);
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('文件路径超出项目范围');
      return rel;
    });
  }

  async status(): Promise<GitSnapshot> {
    if (!this.root) return empty(null);
    try {
      const { stdout } = await this.git(['status', '--porcelain=v1', '-z', '--branch']);
      const parts = stdout.split('\0');
      const snapshot = empty(this.root);
      snapshot.available = true;
      for (const part of parts) {
        if (!part) continue;
        if (part.startsWith('## ')) {
          const branch = part.slice(3);
          const aheadBehind = branch.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
          snapshot.ahead = Number(aheadBehind?.[1] ?? 0);
          snapshot.behind = Number(aheadBehind?.[2] ?? aheadBehind?.[3] ?? 0);
          const name = branch.split('...')[0]!.trim();
          snapshot.detached = name === 'HEAD (no branch)';
          snapshot.branch = snapshot.detached ? null : name;
          continue;
        }
        const status = part.slice(0, 2);
        const path = part.slice(3);
        const group: GitResourceGroup = status.includes('U') || status === 'AA' || status === 'DD'
          ? 'merge' : status === '??' ? 'untracked' : status[0] !== ' ' ? 'index' : 'workingTree';
        const resource: GitResource = { path, status, group };
        snapshot.groups[group].push(resource);
      }
      snapshot.branches = await this.branches();
      try { snapshot.head = (await this.git(['rev-parse', 'HEAD'])).stdout.trim() || null; } catch { /* unborn repo */ }
      return snapshot;
    } catch (err) {
      return empty(this.root, err instanceof Error ? err.message : String(err));
    }
  }

  async stage(paths: string[]): Promise<void> { await this.git(['add', '--', ...this.paths(paths)]); this.invalidate(); }
  async unstage(paths: string[]): Promise<void> { await this.git(['reset', 'HEAD', '--', ...this.paths(paths)]); this.invalidate(); }
  async switchBranch(branch: string): Promise<void> {
    if (typeof branch !== 'string' || branch.trim() === '' || branch.includes('\0')) throw new Error('无效 Git 分支名');
    await this.git(['switch', '--', branch]);
    this.invalidate();
  }
  async commit(message: string): Promise<void> {
    if (typeof message !== 'string' || message.trim() === '') throw new Error('请输入提交信息');
    await this.git(['commit', '-m', message.trim()]);
    this.invalidate();
  }

  private async branches(): Promise<GitBranchInfo[]> {
    const { stdout } = await this.git(['for-each-ref', '--format=%(refname:short)%00%(HEAD)', 'refs/heads']);
    return stdout.split(/\r?\n/).flatMap((line): GitBranchInfo[] => {
      if (!line) return [];
      const separator = line.indexOf('\0');
      if (separator < 1) return [];
      return [{ name: line.slice(0, separator), current: line.slice(separator + 1) === '*' }];
    });
  }
}
