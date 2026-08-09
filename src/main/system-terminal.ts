import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { buildSpawnEnv } from './pty-utils';
import { resolveHostShell } from './session-manager';
import { logger } from './logger';

const SPAWN_ENV_SKIP = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'];
const WINDOWS_TERMINAL_FILE = 'wt.exe';

export type SystemTerminalSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export class SystemTerminalError extends Error {
  constructor(message: string) {
    super(`[SystemTerminal] ${message}`);
    this.name = 'SystemTerminalError';
  }
}

export function buildWindowsTerminalArgs(
  shellFile: string,
  shellArgs: readonly string[],
  cwd: string,
): string[] {
  return ['-w', 'new', '-d', cwd, shellFile, ...shellArgs];
}

/**
 * Launch a visible Windows Terminal window. Iris currently ships Windows builds;
 * missing Windows Terminal and non-Windows platforms fail explicitly.
 */
export function launchSystemTerminal(
  command: string,
  cwd: string,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    spawnFn?: SystemTerminalSpawn;
  } = {},
): Promise<number> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return Promise.reject(
      new SystemTerminalError(`external terminals are not supported on ${platform}`),
    );
  }
  const env = buildSpawnEnv(options.env ?? process.env, SPAWN_ENV_SKIP);
  delete env.FOCUS_DOC;
  delete env.IRIS_WORKSPACE_PATH;
  const host = resolveHostShell(env);
  const terminalArgs = buildWindowsTerminalArgs(host.file, host.buildArgs(command), cwd);
  const spawnFn = options.spawnFn ?? ((file, args, spawnOptions) => spawn(file, args, spawnOptions));

  return new Promise<number>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(WINDOWS_TERMINAL_FILE, terminalArgs, {
        cwd,
        env,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (err) {
      reject(new SystemTerminalError(err instanceof Error ? err.message : String(err)));
      return;
    }
    child.once('error', (err) => reject(new SystemTerminalError(err.message)));
    child.once('spawn', () => {
      child.unref();
      logger.info(
        'system-terminal',
        `launched ${WINDOWS_TERMINAL_FILE} pid=${child.pid ?? 0} shell=${host.file} cwd=${cwd}`,
      );
      resolve(child.pid ?? 0);
    });
  });
}
