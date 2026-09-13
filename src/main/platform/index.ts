import { spawn as nodePtySpawn } from 'node-pty';
import { createShellService } from './shell';
import { createProcessTreeService } from './process-tree';
import { createSystemTerminalService } from './system-terminal';
import { createWindowChromeService } from './window-chrome';
import type { PlatformCapabilities, PlatformServices } from './types';

export function createPlatformServices(platform: NodeJS.Platform = process.platform): PlatformServices {
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') throw new Error(`Unsupported platform: ${platform}`);
  const shell = createShellService(platform);
  const capabilities: PlatformCapabilities = {
    platform, arch: process.arch, shell: shell.resolve(process.env), supportsConpty: platform === 'win32',
    supportsExternalTerminal: true, windowChrome: platform === 'win32' ? 'windows-custom' : platform === 'darwin' ? 'macos-native' : 'linux-native',
  };
  return {
    capabilities, shell, processTree: createProcessTreeService(platform), systemTerminal: createSystemTerminalService(platform), windowChrome: createWindowChromeService(platform),
    spawnPty: (spec) => nodePtySpawn(spec.shell.executable, spec.args, { name: 'xterm-256color', cols: spec.cols, rows: spec.rows, cwd: spec.cwd, env: spec.env, encoding: null, ...(platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}) }),
  };
}

export type { PlatformCapabilities, PlatformServices, ShellService, ShellSpec, ProcessTreeService, SystemTerminalService, WindowChromeService } from './types';
