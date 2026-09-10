/**
 * @file src/main/pty-utils.ts
 * @purpose Pure helpers for the session manager, ported from Marina
 *   (src/main/pty-utils.ts). Only side-effect-free functions that need no
 *   Electron/node-pty mocks to test.
 */

/**
 * Filter undefined values out of process.env into the pure string dict
 * node-pty wants, dropping the given keys (Electron private vars must not
 * leak into child shells).
 */
export function buildSpawnEnv(
  sourceEnv: NodeJS.ProcessEnv,
  skipKeys: Iterable<string> = [],
): Record<string, string> {
  const skip = new Set(skipKeys);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value === 'string' && !skip.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Terminal-host hint env vars (the iTerm2/WezTerm/VS Code convention):
 * TERM (terminfo selection), COLORTERM (truecolor hint), TERM_PROGRAM
 * (host identity — always overwritten so a child shell never sees the
 * host Iris itself was launched from), TERM_PROGRAM_VERSION.
 */
export function injectTerminalHintEnv(
  env: Record<string, string>,
  options: {
    programName: string;
    appVersion?: string;
    term?: string;
    colorTerm?: string;
  },
): Record<string, string> {
  env.TERM = options.term ?? 'xterm-256color';
  env.COLORTERM = options.colorTerm ?? 'truecolor';
  env.TERM_PROGRAM = options.programName;
  if (options.appVersion && options.appVersion.length > 0) {
    env.TERM_PROGRAM_VERSION = options.appVersion;
  } else {
    delete env.TERM_PROGRAM_VERSION;
  }
  return env;
}

/**
 * Non-interactive defaults for unattended PTYs.
 *
 * A real PTY makes `isatty()` true, so Git (and anything else that respects
 * `PAGER`) assumes a human is watching and hands multi-screen output to a
 * pager. Nothing in an Iris Agent command can answer `less` or a `vi` prompt,
 * so the command stalls until the foreground deadline kills it. These values
 * pin every interactive escape hatch to a non-interactive outcome instead:
 *
 * - `GIT_PAGER`/`PAGER` = `cat`: stream output straight through, equivalent
 *   to `git --no-pager` for every Git subcommand at once.
 * - `GIT_TERMINAL_PROMPT` = `0`: fail fast on a missing credential instead of
 *   blocking on a prompt nobody can answer.
 * - `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` = `false`: an operation that needs an
 *   editor (`git commit` without `-m`, `git rebase -i`, `git tag -a`) exits
 *   non-zero with Git's own actionable error — "Please supply the message
 *   using either -m or -F option." — rather than hanging.
 * - `GIT_MERGE_AUTOEDIT` = `no`: a merge commit uses its generated message
 *   instead of opening an editor, so the merge succeeds instead of failing.
 *
 * These overwrite inherited values on purpose: the caller is a background
 * command with no way to press a key, so an inherited `GIT_PAGER=less` is a
 * defect here, not a preference to honor.
 */
export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'false',
  GIT_SEQUENCE_EDITOR: 'false',
  GIT_MERGE_AUTOEDIT: 'no',
});

/** Apply the unattended-command defaults in place and return the same dict. */
export function applyNonInteractiveEnv(
  env: Record<string, string>,
): Record<string, string> {
  Object.assign(env, NON_INTERACTIVE_ENV);
  return env;
}

/**
 * Clamp possibly-bogus cols/rows into ConPTY-safe bounds (0/negative throws
 * in ConPTY; >1000 balloons memory). 80x24 fallback.
 */
export function validateDimensions(
  cols: number,
  rows: number,
  options: { minCols?: number; maxCols?: number; minRows?: number; maxRows?: number } = {},
): { cols: number; rows: number } {
  const minCols = options.minCols ?? 1;
  const maxCols = options.maxCols ?? 1000;
  const minRows = options.minRows ?? 1;
  const maxRows = options.maxRows ?? 1000;
  return {
    cols: clamp(cols, minCols, maxCols, 80),
    rows: clamp(rows, minRows, maxRows, 24),
  };
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
