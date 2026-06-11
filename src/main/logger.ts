/**
 * @file src/main/logger.ts
 * @purpose Minimal console logger for the main process. Tag + level prefix
 *   so smoke tests can pattern-match output. File logging comes in M6.
 */

type Level = 'info' | 'warn' | 'error';

function log(level: Level, tag: string, message: string, detail?: unknown): void {
  const line = `[${tag}] ${message}`;
  const args: unknown[] = detail === undefined ? [line] : [line, detail];
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);
}

export const logger = {
  info: (tag: string, message: string, detail?: unknown) => log('info', tag, message, detail),
  warn: (tag: string, message: string, detail?: unknown) => log('warn', tag, message, detail),
  error: (tag: string, message: string, detail?: unknown) => log('error', tag, message, detail),
};
