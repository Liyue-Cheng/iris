import { execFile } from 'node:child_process';

const PROCESS_TREE_KILL_TIMEOUT_MS = 5000;

export type ProcessTreeKillFn = (pid: number) => Promise<void>;

export function killWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'taskkill.exe',
      ['/pid', String(pid), '/t', '/f'],
      { windowsHide: true, timeout: PROCESS_TREE_KILL_TIMEOUT_MS },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export function defaultProcessTreeKiller(platform = process.platform): ProcessTreeKillFn | null {
  return platform === 'win32' ? killWindowsProcessTree : null;
}
