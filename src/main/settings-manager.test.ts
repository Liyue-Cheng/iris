import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_PRESETS, type DeepPartial, type Settings } from '@shared/types';
import type { JsonStore } from './persistence';
import {
  addRecentRoot,
  deepMerge,
  DEFAULT_SETTINGS,
  MAX_RECENT_ROOTS,
  normalizeAgentSettings,
  projectRootsForStartup,
  removeRecentRoot,
  SettingsManager,
  validateSettings,
} from './settings-manager';

describe('agent launcher settings', () => {
  it('strips legacy behavior fields without changing launcher identity or order', () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as Settings;
    legacy.agents = [
      {
        id: 'codex-work',
        label: 'codex work',
        command: 'codex --profile work',
        injection: 'none',
        onExit: 'close',
      },
      {
        id: 'shell',
        label: 'terminal',
        command: '',
        injection: 'hook',
      },
    ] as unknown as Settings['agents'];

    const normalized = normalizeAgentSettings(legacy);

    expect(normalized.agents).toEqual([
      {
        id: 'codex-work',
        label: 'codex work',
        command: 'codex --profile work',
      },
      { id: 'shell', label: 'terminal', command: '' },
    ]);
    expect(() => validateSettings(normalized)).not.toThrow();
  });

  it('keeps presets independent from the four-item initial launcher list', () => {
    expect(DEFAULT_SETTINGS.agents.map((agent) => agent.id)).toEqual([
      'claude',
      'codex',
      'gemini',
      'shell',
    ]);
    expect(AGENT_PRESETS.map((preset) => preset.id)).toContain('pi');
    expect(AGENT_PRESETS.length).toBeGreaterThan(DEFAULT_SETTINGS.agents.length);
  });

  it('persists the normalized launcher list when loading a legacy main file', async () => {
    const legacy = structuredClone(DEFAULT_SETTINGS);
    legacy.agents = [
      {
        id: 'codex',
        label: 'codex',
        command: 'codex',
        injection: 'hook',
        onExit: 'close',
      },
    ] as unknown as Settings['agents'];
    const set = vi.fn();
    const store = {
      load: vi.fn(async () => ({ value: legacy, source: 'main' as const })),
      set,
    } as unknown as JsonStore<Settings>;
    const manager = new SettingsManager(store);

    await expect(manager.initialize()).resolves.toBe('main');

    expect(manager.get().agents).toEqual([{ id: 'codex', label: 'codex', command: 'codex' }]);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      agents: [{ id: 'codex', label: 'codex', command: 'codex' }],
    }));
  });
});

describe('recent project settings', () => {
  it('adds older settings files with an empty recentRoots default', () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as Settings;
    delete (legacy as Partial<Settings>).locale;
    delete (legacy.project as Partial<Settings['project']>).recentRoots;
    delete (legacy.project as Partial<Settings['project']>).commandTrust;
    const legacyBehavior = legacy.behavior as Partial<Settings['behavior']>;
    delete legacyBehavior.editorAutosave;
    delete legacyBehavior.editorAutosaveDelayMs;
    delete legacyBehavior.editorSaveOnBlur;
    delete legacyBehavior.editorConflictPolicy;
    delete legacyBehavior.terminalDocDrop;
    delete legacyBehavior.autoCheckTodosOnDone;

    const merged = deepMerge(DEFAULT_SETTINGS, legacy as DeepPartial<Settings>);

    expect(merged.project.recentRoots).toEqual([]);
    expect(merged.project.commandTrust).toEqual({});
    expect(merged.locale).toBe('system');
    expect(merged.behavior.restoreProjectsOnStartup).toBe(false);
    expect(merged.behavior.editorAutosave).toBe(true);
    expect(merged.behavior.editorAutosaveDelayMs).toBe(1500);
    expect(merged.behavior.editorSaveOnBlur).toBe(true);
    expect(merged.behavior.editorConflictPolicy).toBe('ask');
    expect(merged.behavior.terminalDocDrop).toBe('content');
    expect(merged.behavior.autoCheckTodosOnDone).toBe(false);
    expect(() => validateSettings(merged)).not.toThrow();
  });

  it('accepts only absolute project roots and SHA-256 trust revisions', () => {
    const valid = structuredClone(DEFAULT_SETTINGS);
    valid.project.commandTrust = { [resolve('fixtures', 'trusted-project')]: 'a'.repeat(64) };
    expect(() => validateSettings(valid)).not.toThrow();

    const relativeRoot = structuredClone(valid);
    relativeRoot.project.commandTrust = { 'relative/project': 'a'.repeat(64) };
    expect(() => validateSettings(relativeRoot)).toThrow(/commandTrust/);

    const invalidRevision = structuredClone(valid);
    invalidRevision.project.commandTrust = { [resolve('fixtures', 'trusted-project')]: 'not-a-sha' };
    expect(() => validateSettings(invalidRevision)).toThrow(/commandTrust/);
  });

  it('starts on welcome by default and restores roots only when enabled', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.project.lastRoot = resolve('fixtures', 'legacy-project');
    settings.project.openRoots = [
      resolve('fixtures', 'first-project'),
      resolve('fixtures', 'second-project'),
    ];

    expect(projectRootsForStartup(settings)).toEqual([]);

    settings.behavior.restoreProjectsOnStartup = true;
    expect(projectRootsForStartup(settings)).toEqual(settings.project.openRoots);

    settings.project.openRoots = [];
    expect(projectRootsForStartup(settings)).toEqual([settings.project.lastRoot]);
  });

  it('accepts only supported locale preferences', () => {
    for (const locale of ['system', 'zh-CN', 'en-US'] as const) {
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.locale = locale;
      expect(() => validateSettings(settings)).not.toThrow();
    }

    const invalid = structuredClone(DEFAULT_SETTINGS);
    invalid.locale = 'zh-TW' as Settings['locale'];
    expect(() => validateSettings(invalid)).toThrow(/locale=.*invalid/);
  });

  it('accepts only supported terminal document drop modes', () => {
    for (const mode of ['path', 'content'] as const) {
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.behavior.terminalDocDrop = mode;
      expect(() => validateSettings(settings)).not.toThrow();
    }

    const invalid = structuredClone(DEFAULT_SETTINGS);
    invalid.behavior.terminalDocDrop = 'clipboard' as Settings['behavior']['terminalDocDrop'];
    expect(() => validateSettings(invalid)).toThrow(/terminalDocDrop=.*path or content/);
  });

  it('requires the automatic Done checkbox setting to be boolean', () => {
    const invalid = structuredClone(DEFAULT_SETTINGS);
    invalid.behavior.autoCheckTodosOnDone = 'yes' as unknown as boolean;
    expect(() => validateSettings(invalid)).toThrow(/autoCheckTodosOnDone must be a boolean/);
  });

  it('moves a duplicate to the front and normalizes its path', () => {
    const first = resolve('fixtures', 'first-project');
    const second = resolve('fixtures', 'second-project');
    const duplicate = process.platform === 'win32' ? first.toUpperCase() : first;

    const result = addRecentRoot([first, second], duplicate);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(resolve(duplicate));
    expect(result[1]).toBe(resolve(second));
  });

  it('keeps only the ten most recently opened projects', () => {
    let roots: string[] = [];
    for (let i = 0; i < MAX_RECENT_ROOTS + 3; i += 1) {
      roots = addRecentRoot(roots, resolve('fixtures', `project-${i}`));
    }

    expect(roots).toHaveLength(MAX_RECENT_ROOTS);
    expect(roots[0]).toBe(resolve('fixtures', `project-${MAX_RECENT_ROOTS + 2}`));
    expect(roots).not.toContain(resolve('fixtures', 'project-0'));
  });

  it('removes only the matching recent project', () => {
    const first = resolve('fixtures', 'first-project');
    const second = resolve('fixtures', 'second-project');
    const target = process.platform === 'win32' ? first.toUpperCase() : first;

    expect(removeRecentRoot([first, second], target)).toEqual([second]);
  });
});
