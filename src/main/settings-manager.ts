/**
 * @file src/main/settings-manager.ts
 * @purpose App settings: load / deep-merge partial update / validate /
 *   persist / broadcast. Pattern ported from Marina's SettingsManager,
 *   trimmed to Iris's M0 schema (theme + fonts).
 *
 * Storage location: ~/.iris/settings.json — the machine-level namespace
 * (software-definition.md §3 规约的作用域链). NOT Electron userData: settings
 * are App-owned citizens of ~/.iris/, alongside the human-owned
 * ~/.iris/CONVENTIONS.md which the App never parses.
 *
 * Settings apply immediately on update (no save button); the manager emits
 * 'settingsChanged' with dotted-path changedKeys for renderer broadcast.
 */
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DeepPartial, Settings, ThemeId } from '@shared/types';
import { getBuildType } from './build-type';
import { JsonStore } from './persistence';

/**
 * Directory of Iris's machine-level namespace — the protocol citizens
 * (~/.iris/CONVENTIONS.md). Always the real ~/.iris regardless of build
 * type: machine facts don't fork between dev and packaged.
 */
export function irisHomeDir(): string {
  return join(homedir(), '.iris');
}

/**
 * Directory App-owned persistence lives in. Dev builds fork to ~/.iris-dev
 * so `npm run dev` and a packaged exe on the same machine never trample each
 * other's settings.json (Marina DEV-COEXIST lesson — there it was solved via
 * per-productName userData; Iris's path is homedir-derived, so the fork is
 * explicit here). Portable and installed share ~/.iris: same machine, same
 * machine-level settings.
 */
export function appDataDir(): string {
  return getBuildType() === 'dev' ? join(homedir(), '.iris-dev') : irisHomeDir();
}

export function settingsFilePath(): string {
  return join(appDataDir(), 'settings.json');
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  appearance: {
    theme: 'rose-pine',
    uiFontFamily: "'LXGW WenKai', system-ui, sans-serif",
    terminalFontFamily:
      "'Cascadia Mono', 'JetBrains Mono', 'Consolas', 'LXGW WenKai Mono', monospace",
    terminalFontSize: 13,
    terminalLineHeight: 1.2,
    uiZoom: 1.0,
  },
  behavior: {
    selectOnCopy: true,
    terminalRightClick: 'menu',
    confirmOnQuit: true,
    editorBlockEdit: false,
  },
  project: {
    lastRoot: null,
  },
  agents: [
    { id: 'claude', label: 'claude', command: 'claude', injection: 'hook' },
    { id: 'shell', label: '终端', command: '', injection: 'none' },
  ],
  advanced: {
    activeIdleThresholdSeconds: 2,
    terminalRenderer: 'auto',
  },
};

const VALID_THEMES: ThemeId[] = ['rose-pine', 'rose-pine-dawn', 'rose-pine-moon'];

export class SettingsError extends Error {
  constructor(
    public readonly code: 'InvalidSettings' | 'IncompatibleVersion',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[SettingsManager] ${code}: ${message}`);
    this.name = 'SettingsError';
  }
}

export class SettingsManager extends EventEmitter {
  private settings: Settings = DEFAULT_SETTINGS;

  constructor(private readonly store: JsonStore<Settings>) {
    super();
  }

  /** Call once at startup. Loads from store, deep-merging over defaults so
   *  files written by older versions gain new fields automatically. */
  async initialize(): Promise<'main' | 'bak' | 'default'> {
    const result = await this.store.load(DEFAULT_SETTINGS);
    const merged = deepMerge(DEFAULT_SETTINGS, result.value as DeepPartial<Settings>);
    if (merged.version !== 1) {
      throw new SettingsError(
        'IncompatibleVersion',
        `settings version=${merged.version} not supported (expected 1); ` +
          `delete ~/.iris/settings.json and restart if downgrading`,
      );
    }
    validateSettings(merged);
    this.settings = merged;
    return result.source;
  }

  /** Deep copy of current settings. */
  get(): Settings {
    return structuredClone(this.settings);
  }

  /**
   * Partial update: deep-merge → validate → commit + persist + emit.
   * @throws SettingsError on validation failure (state unchanged).
   */
  update(partial: DeepPartial<Settings>): void {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      throw new SettingsError(
        'InvalidSettings',
        `partial must be an object, got: ${typeof partial}${Array.isArray(partial) ? ' (Array)' : ''}`,
      );
    }
    const next = deepMerge(this.settings, partial);
    validateSettings(next);

    const changedKeys = diffKeys('', this.settings, next);
    if (changedKeys.length === 0) return;

    this.settings = next;
    this.store.set(structuredClone(next));
    this.emit('settingsChanged', { settings: structuredClone(next), changedKeys });
  }

  /** Wait for pending writes (call before quit). */
  async flush(): Promise<void> {
    await this.store.flush();
  }
}

// ──────────────────────────────────────────────────────────────────
// Utilities (exported for unit tests)
// ──────────────────────────────────────────────────────────────────

/** Deep-merge objects; arrays are replaced wholesale; undefined never overwrites. */
export function deepMerge<T>(target: T, partial: DeepPartial<T> | undefined): T {
  if (partial === undefined || partial === null) return target;
  if (typeof target !== 'object' || target === null) {
    return partial as unknown as T;
  }
  if (Array.isArray(target)) {
    return (Array.isArray(partial) ? partial : target) as T;
  }
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(partial as object)) {
    const partialValue = (partial as Record<string, unknown>)[key];
    if (partialValue === undefined) continue;
    const targetValue = (target as Record<string, unknown>)[key];
    if (
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue) &&
      typeof partialValue === 'object' &&
      partialValue !== null &&
      !Array.isArray(partialValue)
    ) {
      result[key] = deepMerge(targetValue, partialValue as DeepPartial<unknown>);
    } else {
      result[key] = partialValue;
    }
  }
  return result as T;
}

/** Field-level diff as dotted paths ("appearance.theme"). */
export function diffKeys<T>(prefix: string, a: T, b: T): string[] {
  if (a === b) return [];
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null ||
    Array.isArray(a) ||
    Array.isArray(b)
  ) {
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix || '*'];
  }
  const keys = new Set([
    ...Object.keys(a as Record<string, unknown>),
    ...Object.keys(b as Record<string, unknown>),
  ]);
  const result: string[] = [];
  for (const key of keys) {
    const subPrefix = prefix ? `${prefix}.${key}` : key;
    const aVal = (a as Record<string, unknown>)[key];
    const bVal = (b as Record<string, unknown>)[key];
    result.push(...diffKeys(subPrefix, aVal, bVal));
  }
  return result;
}

/** @throws SettingsError on any out-of-range / invalid-enum field. */
export function validateSettings(s: Settings): void {
  if (!VALID_THEMES.includes(s.appearance.theme)) {
    throw new SettingsError(
      'InvalidSettings',
      `appearance.theme="${s.appearance.theme}" invalid, allowed: ${VALID_THEMES.join(', ')}`,
      { field: 'appearance.theme', got: s.appearance.theme, allowed: VALID_THEMES },
    );
  }
  const size = s.appearance.terminalFontSize;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 8 || size > 24) {
    throw new SettingsError(
      'InvalidSettings',
      `appearance.terminalFontSize=${size} out of range [8, 24]`,
    );
  }
  const lineHeight = s.appearance.terminalLineHeight;
  if (
    typeof lineHeight !== 'number' ||
    !Number.isFinite(lineHeight) ||
    lineHeight < 1.0 ||
    lineHeight > 2.0
  ) {
    throw new SettingsError(
      'InvalidSettings',
      `appearance.terminalLineHeight=${lineHeight} out of range [1.0, 2.0]`,
    );
  }
  const zoom = s.appearance.uiZoom;
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < 0.75 || zoom > 1.5) {
    throw new SettingsError(
      'InvalidSettings',
      `appearance.uiZoom=${zoom} out of range [0.75, 1.5]`,
    );
  }
  if (typeof s.behavior.selectOnCopy !== 'boolean') {
    throw new SettingsError('InvalidSettings', 'behavior.selectOnCopy must be a boolean');
  }
  if (!['menu', 'paste'].includes(s.behavior.terminalRightClick)) {
    throw new SettingsError(
      'InvalidSettings',
      `behavior.terminalRightClick="${s.behavior.terminalRightClick}" must be menu or paste`,
    );
  }
  if (typeof s.behavior.confirmOnQuit !== 'boolean') {
    throw new SettingsError('InvalidSettings', 'behavior.confirmOnQuit must be a boolean');
  }
  if (typeof s.behavior.editorBlockEdit !== 'boolean') {
    throw new SettingsError('InvalidSettings', 'behavior.editorBlockEdit must be a boolean');
  }
  if (typeof s.appearance.uiFontFamily !== 'string' || !s.appearance.uiFontFamily.trim()) {
    throw new SettingsError('InvalidSettings', 'appearance.uiFontFamily must be a non-empty string');
  }
  if (
    typeof s.appearance.terminalFontFamily !== 'string' ||
    !s.appearance.terminalFontFamily.trim()
  ) {
    throw new SettingsError(
      'InvalidSettings',
      'appearance.terminalFontFamily must be a non-empty string',
    );
  }
  if (s.project.lastRoot !== null && typeof s.project.lastRoot !== 'string') {
    throw new SettingsError('InvalidSettings', 'project.lastRoot must be a string or null');
  }
  if (!Array.isArray(s.agents) || s.agents.length === 0) {
    throw new SettingsError('InvalidSettings', 'agents must be a non-empty array');
  }
  for (const a of s.agents) {
    if (!a || typeof a.id !== 'string' || !a.id || typeof a.label !== 'string' || !a.label) {
      throw new SettingsError('InvalidSettings', 'each agent needs non-empty id and label');
    }
    if (typeof a.command !== 'string') {
      throw new SettingsError('InvalidSettings', `agent "${a.id}" command must be a string`);
    }
    if (a.injection !== undefined && !['hook', 'flag', 'none'].includes(a.injection)) {
      throw new SettingsError(
        'InvalidSettings',
        `agent "${a.id}" injection must be hook / flag / none (or absent)`,
      );
    }
  }
  const ids = new Set<string>();
  for (const a of s.agents) {
    if (ids.has(a.id)) {
      throw new SettingsError('InvalidSettings', `duplicate agent id "${a.id}"`);
    }
    ids.add(a.id);
  }
  const threshold = s.advanced.activeIdleThresholdSeconds;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0.1 || threshold > 60) {
    throw new SettingsError(
      'InvalidSettings',
      `advanced.activeIdleThresholdSeconds=${threshold} out of range [0.1, 60]`,
    );
  }
  if (!['auto', 'webgl', 'dom'].includes(s.advanced.terminalRenderer)) {
    throw new SettingsError(
      'InvalidSettings',
      `advanced.terminalRenderer="${s.advanced.terminalRenderer}" must be auto / webgl / dom`,
    );
  }
}
