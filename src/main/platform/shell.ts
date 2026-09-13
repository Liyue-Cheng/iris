import { existsSync } from 'node:fs';
import type { ShellService, ShellSpec } from './types';

function posixShell(env: Record<string, string | undefined>): ShellSpec {
  const candidates = [env.SHELL, process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', '/bin/sh'];
  const executable = candidates.find((value): value is string => !!value && existsSync(value)) ?? '/bin/sh';
  return { kind: 'posix', executable, displayName: executable };
}

function windowsShell(env: Record<string, string | undefined>): ShellSpec {
  const pathDirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const find = (name: string): boolean => pathDirs.some((dir) => existsSync(`${dir.replace(/[\\/]+$/u, '')}\\${name}`));
  if (find('pwsh.exe')) return { kind: 'powershell', executable: 'pwsh.exe', displayName: 'PowerShell 7' };
  if (find('powershell.exe')) return { kind: 'powershell', executable: 'powershell.exe', displayName: 'Windows PowerShell' };
  return { kind: 'powershell', executable: 'cmd.exe', displayName: 'Command Prompt' };
}

export function createShellService(platform: NodeJS.Platform): ShellService {
  return {
    resolve: (env) => platform === 'win32' ? windowsShell(env) : posixShell(env),
    interactiveArgs: (shell, command) => {
      if (shell.kind === 'powershell') return shell.executable === 'cmd.exe'
        ? (command ? ['/k', command] : [])
        : (command ? ['-NoLogo', '-NoExit', '-Command', command] : ['-NoLogo']);
      return command ? ['-ilc', command] : ['-il'];
    },
    commandArgs: (shell, command) => shell.kind === 'powershell'
      ? (shell.executable === 'cmd.exe' ? ['/d', '/s', '/c', command] : ['-NoLogo', '-NoProfile', '-Command', command])
      : ['-lc', command],
    quote: (value) => platform === 'win32'
      ? (/[\\\s"']/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value)
      : `'${value.replaceAll("'", "'\\''")}'`,
    pathSeparator: platform === 'win32' ? ';' : ':',
  };
}
