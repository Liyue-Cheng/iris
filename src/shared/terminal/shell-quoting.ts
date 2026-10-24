/** The shell selected when the PTY starts; nested interactive shells are not detected. */
export type TerminalShellKind = 'powershell' | 'cmd' | 'posix' | 'unknown';

/** Environment-selected executables may have a grammar outside the supported shells. */
export function terminalShellKindFromExecutable(executable: string): TerminalShellKind {
  const name = executable.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/, '') ?? '';
  if (name === 'powershell' || name === 'pwsh') return 'powershell';
  if (name === 'cmd') return 'cmd';
  if (['sh', 'bash', 'dash', 'ash', 'ksh', 'mksh', 'zsh'].includes(name)) return 'posix';
  return 'unknown';
}

export type ShellPathRejection = 'unknown-shell' | 'control-character' | 'cmd-expansion';

export class ShellPathQuotingError extends Error {
  constructor(readonly reason: ShellPathRejection) {
    super(`Cannot quote a terminal path: ${reason}`);
    this.name = 'ShellPathQuotingError';
  }
}

/** Quote one literal argument. Never inject terminal controls or guess a shell grammar. */
export function quoteShellPath(path: string, shell: TerminalShellKind): string {
  if (/[\x00-\x1f\x7f-\x9f]/.test(path)) throw new ShellPathQuotingError('control-character');
  switch (shell) {
    case 'powershell':
      // PowerShell also treats typographic single quotes as string delimiters.
      return `'${path.replace(/['\u2018-\u201b]/g, (quote) => quote + quote)}'`;
    case 'posix':
      return `'${path.replace(/'/g, "'\\''")}'`;
    case 'cmd': {
      // Percent expansion also runs inside quotes; delayed expansion may be on.
      // A quote is not a valid Windows filename character and would break out.
      if (/[%!"]/.test(path)) throw new ShellPathQuotingError('cmd-expansion');
      // Keep terminal backslashes outside quotes so native argv parsers do not
      // treat a final backslash as escaping the closing quote.
      const suffix = /\\+$/.exec(path)?.[0] ?? '';
      return `"${path.slice(0, path.length - suffix.length)}"${suffix}`;
    }
    case 'unknown':
      throw new ShellPathQuotingError('unknown-shell');
  }
}

export function joinShellPaths(paths: readonly string[], shell: TerminalShellKind): string {
  return paths.map((path) => quoteShellPath(path, shell)).join(' ');
}
