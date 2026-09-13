import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessTreeService } from './types';

const execFileAsync = promisify(execFile);

export function createProcessTreeService(platform: NodeJS.Platform): ProcessTreeService {
  if (platform === 'win32') {
    return { kill: async (pid) => { await execFileAsync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 5000 }); } };
  }
  return {
    kill: async (pid) => {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { return; } }
      await new Promise((resolve) => setTimeout(resolve, 250));
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
    },
  };
}
