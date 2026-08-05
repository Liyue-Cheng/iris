import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeepPartial, Settings } from '@shared/types';
import {
  addRecentRoot,
  deepMerge,
  DEFAULT_SETTINGS,
  MAX_RECENT_ROOTS,
  projectRootsForStartup,
  removeRecentRoot,
  validateSettings,
} from './settings-manager';

describe('recent project settings', () => {
  it('adds older settings files with an empty recentRoots default', () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as Settings;
    delete (legacy.project as Partial<Settings['project']>).recentRoots;

    const merged = deepMerge(DEFAULT_SETTINGS, legacy as DeepPartial<Settings>);

    expect(merged.project.recentRoots).toEqual([]);
    expect(merged.behavior.restoreProjectsOnStartup).toBe(false);
    expect(() => validateSettings(merged)).not.toThrow();
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
