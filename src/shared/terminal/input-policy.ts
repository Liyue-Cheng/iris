import { joinWindowsShellPaths } from './shell-quoting';

export const DEFAULT_LARGE_PASTE_BYTES = 1024 * 1024;

export type PasteConfirmation =
  | { kind: 'large'; bytes: number }
  | { kind: 'escape' }
  | { kind: 'multiline'; lines: number };

export function pasteConfirmationPlan(
  text: string,
  options: { bracketedPasteMode: boolean; largePasteBytes?: number },
): PasteConfirmation[] {
  const plan: PasteConfirmation[] = [];
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > (options.largePasteBytes ?? DEFAULT_LARGE_PASTE_BYTES)) {
    plan.push({ kind: 'large', bytes });
  }
  if (text.includes('\x1b')) plan.push({ kind: 'escape' });
  if (!options.bracketedPasteMode) {
    const lines = text.split(/\r\n|\r|\n/);
    while (lines.at(-1) === '') lines.pop();
    if (lines.length > 1) plan.push({ kind: 'multiline', lines: lines.length });
  }
  return plan;
}

const SHELL_METAS = /[;&`$|<>(){}\\!*?\n\r]/;

export function droppedPathPlan(paths: readonly string[]): {
  dangerousPaths: string[];
  text: string;
} {
  return {
    dangerousPaths: paths.filter((path) => SHELL_METAS.test(path)),
    text: joinWindowsShellPaths(paths),
  };
}

/** Focus reporting is terminal protocol traffic, not user intent to leave scrollback. */
export function isTerminalFocusReport(data: string): boolean {
  return data === '\x1b[I' || data === '\x1b[O';
}
