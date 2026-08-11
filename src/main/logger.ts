/**
 * @file src/main/logger.ts
 * @purpose Main-process logger: console + best-effort file sink.
 *
 * Packed builds have no visible console, which made the multi-window /
 * double-launch crashes (issue 2026-06-23-多窗口多项目) impossible to diagnose
 * on a user's machine. So every line is also appended to a stable on-disk log
 * — `~/.iris/logs/main-debug.log` — tagged with an ISO timestamp and the PID.
 *
 * The PID matters here: a second portable launch is a SEPARATE process that
 * loses the single-instance lock and exits. Logging both processes to one file
 * (each line carries its own pid) is exactly what lets us see the interleaving:
 * which process forwarded, when the winner opened the new window, and whether a
 * GPU / renderer / child process died in the same instant.
 *
 * The sink is size-capped (see MAX_LOG_BYTES): at the cap it rotates once so a
 * long-lived install can't grow the file without bound.
 *
 * Kept dependency-light on purpose: only `electron` (already in the bundle) and
 * node built-ins, so the featherweight single-instance gate (index.ts) can
 * import it without pulling in the native backend.
 */
import { app } from 'electron';
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rotateFileOnce } from './atomic-write';

type Level = 'info' | 'warn' | 'error';

/** Cap the on-disk log so it can't grow without bound across long sessions. At
 *  the cap we rotate once (…log → ….1.log, overwriting the prior rotation), bounding
 *  total disk use to ~2× this. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Resolve & memoize the log file path; create its dir once. Best-effort —
 *  any failure disables the file sink for this run (console still works). */
let logFilePath: string | null = null;
let fileSinkDisabled = false;
let bytesWritten = 0;
function resolveLogFile(): string | null {
  if (logFilePath) return logFilePath;
  if (fileSinkDisabled) return null;
  try {
    // Dev forks to ~/.iris-dev (mirrors appDataDir) so a dev run never writes
    // into the same log a packaged build is diagnosing. Packaged (portable /
    // installed) → ~/.iris. Resolved without importing settings-manager to keep
    // index.ts's import graph down to electron + built-ins.
    const base = app.isPackaged ? join(homedir(), '.iris') : join(homedir(), '.iris-dev');
    const dir = join(base, 'logs');
    mkdirSync(dir, { recursive: true });
    logFilePath = join(dir, 'main-debug.log');
    // Seed the running byte count from any existing file so the cap accounts
    // for what a prior run already left behind.
    try {
      bytesWritten = statSync(logFilePath).size;
    } catch {
      bytesWritten = 0;
    }
    return logFilePath;
  } catch {
    fileSinkDisabled = true;
    return null;
  }
}

function detailToString(detail: unknown): string {
  if (detail === undefined) return '';
  if (detail instanceof Error) return ` ${detail.stack ?? detail.message}`;
  if (typeof detail === 'string') return ` ${detail}`;
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return ` ${String(detail)}`;
  }
}

function writeFileSink(level: Level, tag: string, message: string, detail?: unknown): void {
  const file = resolveLogFile();
  if (!file) return;
  try {
    const ts = new Date().toISOString();
    const line = `${ts} [pid ${process.pid}] [${level}] [${tag}] ${message}${detailToString(detail)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytesWritten + bytes > MAX_LOG_BYTES) {
      try {
        rotateFileOnce(file);
      } catch {
        /* best effort — fall through and keep appending to the current file */
      }
      bytesWritten = 0;
    }
    appendFileSync(file, line);
    bytesWritten += bytes;
  } catch {
    // Best-effort: a locked / unwritable log must never break the app.
    fileSinkDisabled = true;
  }
}

function log(level: Level, tag: string, message: string, detail?: unknown): void {
  const line = `[${tag}] ${message}`;
  const args: unknown[] = detail === undefined ? [line] : [line, detail];
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);
  writeFileSink(level, tag, message, detail);
}

export const logger = {
  info: (tag: string, message: string, detail?: unknown) => log('info', tag, message, detail),
  warn: (tag: string, message: string, detail?: unknown) => log('warn', tag, message, detail),
  error: (tag: string, message: string, detail?: unknown) => log('error', tag, message, detail),
  /** Absolute path of the on-disk log (or null if the sink is unavailable). */
  filePath: (): string | null => resolveLogFile(),
};
