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
