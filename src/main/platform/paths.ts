import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { getBuildType } from '../build-type';

export function irisHomeDir(): string { return join(homedir(), '.iris'); }
export function appDataDir(): string { return getBuildType() === 'dev' ? join(homedir(), '.iris-dev') : irisHomeDir(); }
export function settingsFilePath(): string { return join(appDataDir(), 'settings.json'); }
export function normalizeProjectRoot(value: string): string { try { return realpathSync(value); } catch { return normalize(value); } }
export function equalProjectRoot(a: string, b: string): boolean {
  const left = normalizeProjectRoot(a); const right = normalizeProjectRoot(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
