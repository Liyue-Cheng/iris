import type { BrowserWindowConstructorOptions } from 'electron';
import type { IPty } from 'node-pty';

export type SupportedPlatform = 'win32' | 'darwin' | 'linux';
export type ShellKind = 'powershell' | 'posix';

export interface ShellSpec {
  kind: ShellKind;
  executable: string;
  displayName: string;
}

export interface PlatformCapabilities {
  platform: SupportedPlatform;
  arch: string;
  shell: ShellSpec;
  supportsConpty: boolean;
  supportsExternalTerminal: boolean;
  windowChrome: 'windows-custom' | 'macos-native' | 'linux-native';
}

export interface PtySpawnSpec {
  shell: ShellSpec;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface ShellService {
  resolve(env: Record<string, string | undefined>): ShellSpec;
  interactiveArgs(shell: ShellSpec, command?: string): string[];
  commandArgs(shell: ShellSpec, command: string): string[];
  quote(path: string): string;
  pathSeparator: ':' | ';';
}

export interface ProcessTreeService {
  kill(pid: number): Promise<void>;
}

export interface SystemTerminalService {
  launch(command: string, cwd: string, env?: Record<string, string>): Promise<number>;
}

export interface WindowChromeService {
  options(icon?: string): BrowserWindowConstructorOptions;
  shouldQuitWhenLastWindowCloses(): boolean;
}

export interface PlatformServices {
  capabilities: PlatformCapabilities;
  shell: ShellService;
  processTree: ProcessTreeService;
  systemTerminal: SystemTerminalService;
  windowChrome: WindowChromeService;
  spawnPty(spec: PtySpawnSpec): IPty;
}
