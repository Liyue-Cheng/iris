export function quoteWindowsShellPath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

export function joinWindowsShellPaths(paths: readonly string[]): string {
  return paths.map(quoteWindowsShellPath).join(' ');
}
