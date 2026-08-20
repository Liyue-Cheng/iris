/**
 * @file src/main/settings-manager.ts
 * @purpose App settings: load / deep-merge partial update / validate /
 *   persist / broadcast. Pattern ported from Marina's SettingsManager,
 *   trimmed to Iris's M0 schema (theme + fonts).
 *
 * Storage location: ~/.iris/settings.json — Iris's machine-level namespace.
 * NOT Electron userData.
 *
 * Settings apply immediately on update (no save button); the manager emits
 * 'settingsChanged' with dotted-path changedKeys for renderer broadcast.
 */
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import {
  AGENT_PRESETS,
  type AgentConfig,
  type DeepPartial,
  type LocalePreference,
  type Settings,
  type ThemeId,
} from '@shared/types';
import { getBuildType } from './build-type';
import { JsonStore } from './persistence';

/**
 * Directory of Iris's machine-level namespace. Always the real ~/.iris so
 * generated hook scripts remain stable across dev and packaged builds.
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

export const MAX_RECENT_ROOTS = 10;

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  locale: 'system',
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
    restoreProjectsOnStartup: false,
    selectOnCopy: true,
    terminalRightClick: 'menu',
    terminalDocDrop: 'content',
    autoCheckTodosOnDone: false,
    confirmOnQuit: true,
    editorBlockEdit: false,
    editorBodyAlign: 'center',
    editorMaxWidth: 58,
    editorAutosave: true,
    editorAutosaveDelayMs: 1500,
    editorSaveOnBlur: true,
    editorConflictPolicy: 'ask',
  },
  project: {
    lastRoot: null,
    openRoots: [],
    recentRoots: [],
    commandTrust: {},
  },
  experimental: {
    irisAgent: false,
  },
  agents: AGENT_PRESETS.filter((preset) =>
    ['claude', 'codex', 'gemini', 'shell'].includes(preset.id),
  ).map((preset) => ({ ...preset })),
  advanced: {
    activeIdleThresholdSeconds: 2,
    terminalRenderer: 'auto',
  },
};

const VALID_THEMES: ThemeId[] = [
  'rose-pine',
  'rose-pine-dawn',
  'rose-pine-moon',
  'cutie',
  'business',
  'ubuntu',
  'windows-terminal',
  'one-dark-pro',
  'dracula',
  'tokyo-night',
  'catppuccin-mocha',
  'catppuccin-latte',
  'tokyo-night-day',
  'light-pink',
  'fairyfloss',
];

const VALID_LOCALES: LocalePreference[] = ['system', 'zh-CN', 'en-US'];

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
    const loaded = deepMerge(DEFAULT_SETTINGS, result.value as DeepPartial<Settings>);
    const hadLegacyAgentFields =
      Array.isArray(loaded.agents) &&
      loaded.agents.some(
        (agent) =>
          agent &&
          typeof agent === 'object' &&
          ('injection' in agent || 'onExit' in agent),
      );
    const merged = normalizeAgentSettings(loaded);
    if (merged.version !== 1) {
      throw new SettingsError(
        'IncompatibleVersion',
        `settings version=${merged.version} not supported (expected 1); ` +
          `delete ~/.iris/settings.json and restart if downgrading`,
      );
    }
    validateSettings(merged);
    this.settings = merged;
    if (hadLegacyAgentFields && result.source === 'main') {
      this.store.set(structuredClone(merged));
    }
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
    const next = normalizeAgentSettings(deepMerge(this.settings, partial));
    validateSettings(next);

    const changedKeys = diffKeys('', this.settings, next);
    if (changedKeys.length === 0) return;

    this.settings = next;
    this.store.set(structuredClone(next));
    this.emit('settingsChanged', { settings: structuredClone(next), changedKeys });
  }

  /** Record a successfully opened project in most-recent-first order. */
  recordRecentProject(root: string): void {
    this.update({
      project: { recentRoots: addRecentRoot(this.settings.project.recentRoots, root) },
    });
  }

  /** Forget one recent project without affecting open-window restoration. */
  removeRecentProject(root: string): void {
    this.update({
      project: { recentRoots: removeRecentRoot(this.settings.project.recentRoots, root) },
    });
  }

  /** Approve one exact revision of executable project settings on this machine. */
  trustProjectCommands(root: string, revision: string): void {
    this.update({ project: { commandTrust: { [root]: revision } } });
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

/**
 * Strip legacy/inert launcher properties while preserving the stable fields
 * and array order. Invalid values are left structurally invalid so the normal
 * settings validator can report them instead of silently repairing data.
 */
export function normalizeAgentSettings(settings: Settings): Settings {
  if (!Array.isArray(settings.agents)) return settings;
  const agents = settings.agents.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value as AgentConfig;
    }
    const source = value as AgentConfig;
    const launcher: AgentConfig = {
      id: source.id,
      label: source.label,
      command: source.command,
    };
    return launcher;
  });
  return { ...settings, agents };
}

/** Normalize for storage while preserving the filesystem's display casing. */
function normalizeRecentRoot(root: string): string {
  return normalize(resolve(root));
}

/** Windows paths are case-insensitive; other platforms keep native semantics. */
function recentRootKey(root: string): string {
  const normalized = normalizeRecentRoot(root);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function addRecentRoot(current: readonly string[], root: string): string[] {
  const normalized = normalizeRecentRoot(root);
  const key = recentRootKey(normalized);
  const rest = current
    .map(normalizeRecentRoot)
    .filter((item) => recentRootKey(item) !== key);
  return [normalized, ...rest].slice(0, MAX_RECENT_ROOTS);
}

export function removeRecentRoot(current: readonly string[], root: string): string[] {
  const key = recentRootKey(root);
  return current
    .map(normalizeRecentRoot)
    .filter((item) => recentRootKey(item) !== key)
    .slice(0, MAX_RECENT_ROOTS);
}

/** Startup projection: welcome page by default, optional multi-window restore. */
export function projectRootsForStartup(settings: Settings): string[] {
  if (!settings.behavior.restoreProjectsOnStartup) return [];
  if (settings.project.openRoots.length > 0) return [...settings.project.openRoots];
  return settings.project.lastRoot ? [settings.project.lastRoot] : [];
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
  if (!VALID_LOCALES.includes(s.locale)) {
    throw new SettingsError(
      'InvalidSettings',
      `locale="${s.locale}" invalid, allowed: ${VALID_LOCALES.join(', ')}`,
      { field: 'locale', got: s.locale, allowed: VALID_LOCALES },
    );
  }
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
  if (typeof s.behavior.restoreProjectsOnStartup !== 'boolean') {
    throw new SettingsError(
      'InvalidSettings',
      'behavior.restoreProjectsOnStartup must be a boolean',
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
  if (!['path', 'content'].includes(s.behavior.terminalDocDrop)) {
    throw new SettingsError(
      'InvalidSettings',
      `behavior.terminalDocDrop="${s.behavior.terminalDocDrop}" must be path or content`,
    );
  }
  if (typeof s.behavior.autoCheckTodosOnDone !== 'boolean') {
    throw new SettingsError('InvalidSettings', 'behavior.autoCheckTodosOnDone must be a boolean');
  }
  if (typeof s.behavior.confirmOnQuit !== 'boolean') {
    throw new SettingsError('InvalidSettings', 'behavior.confirmOnQuit must be a boolean');
  }
  if (typeof s.behavior.editorBlockEdit !== 'boolean') {
    throw new SettingsError('InvalidSettings', 'behavior.editorBlockEdit must be a boolean');
  }
  if (!['center', 'left'].includes(s.behavior.editorBodyAlign)) {
    throw new SettingsError(
      'InvalidSettings',
      `behavior.editorBodyAlign="${s.behavior.editorBodyAlign}" must be center or left`,
    );
  }
  if (
    typeof s.behavior.editorMaxWidth !== 'number' ||
    !Number.isFinite(s.behavior.editorMaxWidth) ||
    s.behavior.editorMaxWidth < 30 ||
    s.behavior.editorMaxWidth > 120
  ) {
    throw new SettingsError(
      'InvalidSettings',
      `behavior.editorMaxWidth=${s.behavior.editorMaxWidth} must be a number in [30, 120]`,
    );
  }
  if (typeof s.behavior.editorAutosave !== 'boolean') {
    throw new SettingsError('InvalidSettings', 'behavior.editorAutosave must be a boolean');
  }
  if (
    typeof s.behavior.editorAutosaveDelayMs !== 'number' ||
    !Number.isFinite(s.behavior.editorAutosaveDelayMs) ||
    s.behavior.editorAutosaveDelayMs < 300 ||
    s.behavior.editorAutosaveDelayMs > 10000
  ) {
    throw new SettingsError(
      'InvalidSettings',
      `behavior.editorAutosaveDelayMs=${s.behavior.editorAutosaveDelayMs} must be a number in [300, 10000]`,
    );
  }
  if (typeof s.behavior.editorSaveOnBlur !== 'boolean') {
    throw new SettingsError('InvalidSettings', 'behavior.editorSaveOnBlur must be a boolean');
  }
  if (!['ask', 'overwrite'].includes(s.behavior.editorConflictPolicy)) {
    throw new SettingsError(
      'InvalidSettings',
      `behavior.editorConflictPolicy="${s.behavior.editorConflictPolicy}" must be ask or overwrite`,
    );
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
  if (!Array.isArray(s.project.openRoots) || s.project.openRoots.some((r) => typeof r !== 'string')) {
    throw new SettingsError('InvalidSettings', 'project.openRoots must be a string[]');
  }
  if (
    !Array.isArray(s.project.recentRoots) ||
    s.project.recentRoots.length > MAX_RECENT_ROOTS ||
    s.project.recentRoots.some((r) => typeof r !== 'string' || !isAbsolute(r))
  ) {
    throw new SettingsError(
      'InvalidSettings',
      `project.recentRoots must be an absolute string[] with at most ${MAX_RECENT_ROOTS} entries`,
    );
  }
  if (
    !s.project.commandTrust ||
    typeof s.project.commandTrust !== 'object' ||
    Array.isArray(s.project.commandTrust) ||
    Object.entries(s.project.commandTrust).some(
      ([root, revision]) => !isAbsolute(root) || !/^[a-f\d]{64}$/.test(revision),
    )
  ) {
    throw new SettingsError(
      'InvalidSettings',
      'project.commandTrust must map absolute project roots to SHA-256 revisions',
    );
  }
  if (typeof s.experimental.irisAgent !== 'boolean') {
    throw new SettingsError('InvalidSettings', 'experimental.irisAgent must be a boolean');
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
