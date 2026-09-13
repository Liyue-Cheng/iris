import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import type { SystemTerminalService } from './types';

function launch(file: string, args: string[], cwd: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: 'ignore', windowsHide: process.platform === 'win32' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid ?? 0); });
  });
}

export function createSystemTerminalService(platform: NodeJS.Platform): SystemTerminalService {
  return {
    launch: async (command, cwd, inputEnv = process.env as Record<string, string>) => {
      const env = { ...inputEnv };
      if (platform === 'win32') return launch('wt.exe', ['-w', 'new', '-d', cwd, 'cmd.exe', '/k', command], cwd, env);
      if (platform === 'darwin') return launch('open', ['-a', 'Terminal', '--args', 'bash', '-lc', `cd ${JSON.stringify(cwd)} && ${command}`], cwd, env);
      const candidates = [
        ['x-terminal-emulator', ['-e', 'sh', '-lc', command]],
        ['gnome-terminal', ['--working-directory', cwd, '--', 'sh', '-lc', command]],
        ['konsole', ['--workdir', cwd, '-e', 'sh', '-lc', command]],
        ['xfce4-terminal', ['--working-directory', cwd, '--command', `sh -lc ${JSON.stringify(command)}`]],
      ] as const;
      const provider = candidates.find(([file]) => {
        try { execFileSync('which', [file], { stdio: 'ignore' }); return true; } catch { return false; }
      });
      if (!provider) throw new Error('No supported Linux terminal emulator was found');
      return launch(provider[0], [...provider[1]], cwd, env);
    },
  };
}
