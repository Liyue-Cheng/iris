/**
 * @file src/main/platform/child-env.ts
 * @purpose Environment for child processes (terminals, system terminal, git)
 *   that reflects the user's CURRENT Windows environment, not the snapshot the
 *   Iris main process inherited at launch.
 *
 * Why: Iris is single-instance — every window shares one long-lived main
 * process, and `process.env` is frozen when that process starts. A CLI
 * installer that edits the user/machine Path (winget, standalone installers,
 * `setx`, …) is therefore invisible to new Iris terminals until every Iris
 * window is closed, while Windows Terminal (which re-reads the registry) finds
 * the command. See .iris/issue/2026-08-24-命令行路径问题.md.
 *
 * Strategy (conservative, additive):
 *   - Read HKLM Session Manager\Environment and HKCU\Environment via
 *     `reg export` (UTF-16LE output, so non-ASCII paths survive; `reg query`
 *     prints in the console code page and would mangle them).
 *   - Build the registry environment the way Windows does: machine vars, then
 *     user vars; Path = machine Path + user Path; REG_EXPAND_SZ expanded.
 *   - Merge into the inherited env WITHOUT changing existing behavior: keep the
 *     inherited Path entries in their order and only APPEND directories that
 *     are new; only ADD variables the inherited env does not have. Values the
 *     process already has are never overwritten.
 *   - Refresh asynchronously (callers await `refresh()` before spawning, and the
 *     app pre-warms it on window focus); `resolve()` is synchronous and uses the
 *     last good snapshot. Any read failure falls back to the inherited env.
 *
 * Non-Windows platforms: `refresh()` is a no-op and `resolve()` returns a copy
 * of the inherited env.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger';

export interface RegistryValue {
  name: string;
  value: string;
  /** REG_EXPAND_SZ — `%VAR%` references are expanded. */
  expand: boolean;
}

export interface RegistryEnvironmentSnapshot {
  machine: RegistryValue[];
  user: RegistryValue[];
}

export const MACHINE_ENV_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
export const USER_ENV_KEY = 'HKCU\\Environment';

const REG_TIMEOUT_MS = 3000;
/** A snapshot this recent is reused instead of re-reading the registry. */
const FRESH_WINDOW_MS = 1000;

// ── pure helpers ──────────────────────────────────────────────────────

function unescapeRegString(text: string): string {
  return text.replace(/\\(.)/gu, '$1');
}

function decodeHexUtf16(hexList: string): string | null {
  const parts = hexList.split(',').map((part) => part.trim()).filter(Boolean);
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,2}$/iu.test(part)) return null;
    bytes.push(Number.parseInt(part, 16));
  }
  return Buffer.from(bytes).toString('utf16le').replace(/\0+$/u, '');
}

/**
 * Parse the FIRST key section of a `reg export` file (already decoded to a
 * string). Only REG_SZ (`"x"`) and REG_EXPAND_SZ (`hex(2):`) values are kept;
 * DWORD/binary/multi-string values and subkey sections are ignored.
 */
export function parseRegExport(text: string): RegistryValue[] {
  const rawLines = text.replace(/^﻿/u, '').split(/\r?\n/u);
  // Join `\`-continued lines (hex dumps wrap at ~80 columns).
  const lines: string[] = [];
  let pending = '';
  for (const raw of rawLines) {
    const line = pending ? pending + raw.trimStart() : raw;
    if (line.endsWith('\\') && /=hex(\([0-9a-f]+\))?:/iu.test(line)) {
      pending = line.slice(0, -1);
      continue;
    }
    pending = '';
    lines.push(line);
  }
  if (pending) lines.push(pending);

  const values: RegistryValue[] = [];
  let sectionsSeen = 0;
  for (const line of lines) {
    if (line.startsWith('[')) {
      sectionsSeen += 1;
      if (sectionsSeen > 1) break;
      continue;
    }
    if (sectionsSeen !== 1) continue;
    const match = /^"((?:[^"\\]|\\.)*)"=(.*)$/u.exec(line);
    const rawName = match?.[1];
    const data = match?.[2];
    if (rawName === undefined || data === undefined) continue;
    const name = unescapeRegString(rawName);
    if (data.startsWith('"') && data.endsWith('"') && data.length >= 2) {
      values.push({ name, value: unescapeRegString(data.slice(1, -1)), expand: false });
    } else if (data.toLowerCase().startsWith('hex(2):')) {
      const decoded = decodeHexUtf16(data.slice('hex(2):'.length));
      if (decoded !== null) values.push({ name, value: decoded, expand: true });
    }
  }
  return values;
}

function lowerKeyMap(env: Record<string, string | undefined>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && !map.has(key.toLowerCase())) map.set(key.toLowerCase(), value);
  }
  return map;
}

/**
 * Build the environment Windows would give a freshly started process from the
 * registry: machine values, then user values (user overrides), with
 * Path = machine Path + `;` + user Path. `%VAR%` in REG_EXPAND_SZ values is
 * expanded against the registry vars built so far, then the inherited env;
 * unknown references are left as-is (Windows does the same).
 */
export function buildRegistryEnvironment(
  snapshot: RegistryEnvironmentSnapshot,
  inherited: Record<string, string | undefined>,
): Map<string, { name: string; value: string }> {
  const result = new Map<string, { name: string; value: string }>();
  const inheritedLower = lowerKeyMap(inherited);
  const lookup = (name: string): string | undefined =>
    result.get(name.toLowerCase())?.value ?? inheritedLower.get(name.toLowerCase());
  const expand = (value: string): string =>
    value.replace(/%([^%;]+)%/gu, (whole, name: string) => lookup(name) ?? whole);

  const pathParts: string[] = [];
  const apply = (values: RegistryValue[]): void => {
    // Plain values first so expandable ones can reference them.
    const ordered = [...values.filter((v) => !v.expand), ...values.filter((v) => v.expand)];
    for (const entry of ordered) {
      const value = entry.expand ? expand(entry.value) : entry.value;
      if (entry.name.toLowerCase() === 'path') {
        if (value) pathParts.push(value);
        continue;
      }
      result.set(entry.name.toLowerCase(), { name: entry.name, value });
    }
  };
  apply(snapshot.machine);
  apply(snapshot.user);
  if (pathParts.length > 0) result.set('path', { name: 'Path', value: pathParts.join(';') });
  return result;
}

function normalizePathEntry(entry: string): string {
  return entry.trim().replace(/[\\/]+$/u, '').toLowerCase();
}

/**
 * Merge the registry environment into the inherited env, additively:
 *   - inherited Path entries keep their order; registry Path entries not yet
 *     present (case-insensitive, trailing slash ignored) are appended;
 *   - registry variables absent from the inherited env are added;
 *   - inherited values are never overwritten.
 */
export function mergeRegistryEnvironment(
  inherited: Record<string, string | undefined>,
  registry: Map<string, { name: string; value: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const present = new Set<string>();
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value !== 'string') continue;
    out[key] = value;
    present.add(key.toLowerCase());
  }

  const registryPath = registry.get('path')?.value;
  if (registryPath) {
    const pathKey = Object.keys(out).find((key) => key.toLowerCase() === 'path') ?? 'Path';
    const current = (out[pathKey] ?? '').split(';').filter((entry) => entry.trim() !== '');
    const seen = new Set(current.map(normalizePathEntry));
    for (const entry of registryPath.split(';')) {
      if (entry.trim() === '') continue;
      const key = normalizePathEntry(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      current.push(entry);
    }
    out[pathKey] = current.join(';');
    present.add('path');
  }

  for (const [lower, { name, value }] of registry) {
    if (lower === 'path' || present.has(lower)) continue;
    out[name] = value;
    present.add(lower);
  }
  return out;
}

// ── registry reader ───────────────────────────────────────────────────

export type RegistryExportReader = (key: string) => Promise<string>;

/** `reg export <key> <tmp> /y`, read back as UTF-16LE, temp file removed. */
export const readRegistryExport: RegistryExportReader = async (key) => {
  const file = join(tmpdir(), `iris-env-${process.pid}-${randomUUID()}.reg`);
  try {
    await new Promise<void>((resolvePromise, reject) => {
      execFile(
        'reg.exe',
        ['export', key, file, '/y'],
        { windowsHide: true, timeout: REG_TIMEOUT_MS },
        (err) => (err ? reject(err) : resolvePromise()),
      );
    });
    return (await readFile(file)).toString('utf16le');
  } finally {
    await unlink(file).catch(() => undefined);
  }
};

// ── service ───────────────────────────────────────────────────────────

export interface ChildEnvironment {
  /** Re-read the registry. Never rejects; failures keep the last snapshot. */
  refresh(): Promise<void>;
  /** The env to hand a child process, derived from `inherited` (default process.env). */
  resolve(inherited?: Record<string, string | undefined>): Record<string, string>;
}

export function createChildEnvironment(options: {
  platform?: NodeJS.Platform;
  readExport?: RegistryExportReader;
  now?: () => number;
} = {}): ChildEnvironment {
  const platform = options.platform ?? process.platform;
  const readExport = options.readExport ?? readRegistryExport;
  const now = options.now ?? Date.now;
  let snapshot: RegistryEnvironmentSnapshot | null = null;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  const copy = (env: Record<string, string | undefined>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
    return out;
  };

  return {
    refresh() {
      if (platform !== 'win32') return Promise.resolve();
      if (inFlight) return inFlight;
      if (now() - refreshedAt < FRESH_WINDOW_MS) return Promise.resolve();
      inFlight = (async () => {
        try {
          const [machineText, userText] = await Promise.all([
            readExport(MACHINE_ENV_KEY),
            readExport(USER_ENV_KEY),
          ]);
          snapshot = { machine: parseRegExport(machineText), user: parseRegExport(userText) };
          refreshedAt = now();
        } catch (err) {
          logger.warn('env', 'registry environment refresh failed — using last known environment', err);
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
    resolve(inherited = process.env) {
      if (platform !== 'win32' || !snapshot) return copy(inherited);
      try {
        return mergeRegistryEnvironment(inherited, buildRegistryEnvironment(snapshot, inherited));
      } catch (err) {
        logger.warn('env', 'registry environment merge failed — using inherited environment', err);
        return copy(inherited);
      }
    },
  };
}

/** Process-wide instance shared by every window's managers. */
export const childEnvironment: ChildEnvironment = createChildEnvironment();
