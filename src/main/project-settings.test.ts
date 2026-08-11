import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDataDir, removeTempDataDir } from './persistence';
import {
  MAX_PROJECT_SETTINGS_BYTES,
  MISSING_PROJECT_SETTINGS_REVISION,
  ProjectSettingsError,
  readProjectSettings,
  updateProjectPrompt,
  updateProjectEntries,
  updateProjectToolbar,
} from './project-settings';

describe('project settings', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempDataDir('iris-project-settings-');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDataDir(root);
  });

  it('projects a missing file as empty defaults without creating it', async () => {
    const snapshot = await readProjectSettings(root);
    expect(snapshot).toMatchObject({
      exists: false,
      revision: MISSING_PROJECT_SETTINGS_REVISION,
      error: null,
      settings: {
        version: 1,
        prompts: { project: '' },
        agentContext: { entries: ['AGENTS.md'] },
        toolbar: { actions: [] },
      },
    });
    await expect(fs.access(join(root, '.iris', 'settings.json'))).rejects.toThrow();
  });

  it('writes atomically, normalizes fields, and preserves unknown settings', async () => {
    await fs.mkdir(join(root, '.iris'));
    await fs.writeFile(
      join(root, '.iris', 'settings.json'),
      `${JSON.stringify({ version: 1, prompts: { project: 'Keep me' }, toolbar: { future: true } })}\n`,
      'utf8',
    );
    const before = await readProjectSettings(root);
    const after = await updateProjectToolbar(
      root,
      [
        {
          icon: 'rocket',
          description: ' Start dev ',
          command: ' npm run dev ',
          terminal: 'iris',
        },
      ],
      before.revision,
    );

    expect(after.settings.toolbar.actions).toEqual([
      { icon: 'rocket', description: 'Start dev', command: 'npm run dev', terminal: 'iris' },
    ]);
    const disk = JSON.parse(await fs.readFile(join(root, '.iris', 'settings.json'), 'utf8')) as {
      prompts: { project: string };
      toolbar: { future: boolean };
    };
    expect(disk.prompts.project).toBe('Keep me');
    expect(disk.toolbar.future).toBe(true);
  });

  it('rejects a stale revision without changing disk', async () => {
    const first = await updateProjectToolbar(
      root,
      [{ icon: 'play', description: 'First', command: 'one', terminal: 'iris' }],
      MISSING_PROJECT_SETTINGS_REVISION,
    );
    await updateProjectToolbar(
      root,
      [{ icon: 'play', description: 'Second', command: 'two', terminal: 'iris' }],
      first.revision,
    );

    await expect(
      updateProjectToolbar(
        root,
        [{ icon: 'play', description: 'Stale', command: 'three', terminal: 'iris' }],
        first.revision,
      ),
    ).rejects.toMatchObject({ code: 'WriteConflict' } satisfies Partial<ProjectSettingsError>);
    expect((await readProjectSettings(root)).settings.toolbar.actions[0]?.description).toBe('Second');
  });

  it('rejects a stale project-prompt draft without overwriting the newer window', async () => {
    const baseline = await readProjectSettings(root);
    const firstWindow = await updateProjectPrompt(root, 'First window', baseline.revision);
    const secondWindow = await updateProjectPrompt(root, 'Second window', firstWindow.revision);

    await expect(
      updateProjectPrompt(root, 'Stale first-window draft', firstWindow.revision),
    ).rejects.toMatchObject({ code: 'WriteConflict' } satisfies Partial<ProjectSettingsError>);
    expect((await readProjectSettings(root)).settings.prompts.project).toBe('Second window');
    expect(secondWindow.revision).not.toBe(firstWindow.revision);
  });

  it('persists an explicit deduplicated entry list and requires AGENTS.md', async () => {
    const baseline = await readProjectSettings(root);
    const snapshot = await updateProjectEntries(
      root,
      ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.md'],
      baseline.revision,
    );
    expect(snapshot.settings.agentContext.entries).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(snapshot.entryListExplicit).toBe(true);

    await expect(
      updateProjectEntries(root, ['CLAUDE.md'], snapshot.revision),
    ).rejects.toMatchObject({ code: 'InvalidSettings' } satisfies Partial<ProjectSettingsError>);
  });

  it('rejects unsupported projection targets from project settings', async () => {
    const baseline = await readProjectSettings(root);
    await expect(
      updateProjectEntries(root, ['AGENTS.md', '../outside.md'], baseline.revision),
    ).rejects.toMatchObject({ code: 'InvalidSettings' } satisfies Partial<ProjectSettingsError>);
  });

  it('validates prompts.project without overwriting invalid JSON shapes', async () => {
    await fs.mkdir(join(root, '.iris'));
    const path = join(root, '.iris', 'settings.json');
    await fs.writeFile(
      path,
      `${JSON.stringify({ version: 1, prompts: { project: 42 }, toolbar: { actions: [] } })}\n`,
      'utf8',
    );
    const snapshot = await readProjectSettings(root);
    expect(snapshot.error).toBe('prompts.project must be a string');
    await expect(
      updateProjectPrompt(root, 'Do not write', snapshot.revision),
    ).rejects.toMatchObject({ code: 'InvalidSettings' } satisfies Partial<ProjectSettingsError>);
    expect(JSON.parse(await fs.readFile(path, 'utf8')).prompts.project).toBe(42);
  });

  it('reports invalid actions while retaining valid actions in order', async () => {
    await fs.mkdir(join(root, '.iris'));
    await fs.writeFile(
      join(root, '.iris', 'settings.json'),
      `${JSON.stringify({
        version: 1,
        toolbar: {
          actions: [
            { icon: 'rocket', description: 'Valid', command: 'run', terminal: 'system' },
            { icon: 'not-a-real-icon', description: 'Unknown icon', command: 'run', terminal: 'iris' },
            { icon: 'Bad Icon', description: '', command: '', terminal: 'elsewhere' },
            { icon: 'git-branch', description: 'Also valid', command: 'git status', terminal: 'iris' },
          ],
        },
      })}\n`,
      'utf8',
    );

    const snapshot = await readProjectSettings(root);
    expect(snapshot.error).toBeNull();
    expect(snapshot.diagnostics).toHaveLength(2);
    expect(snapshot.settings.toolbar.actions.map((action) => action.description)).toEqual([
      'Valid',
      'Also valid',
    ]);
  });

  it('does not overwrite malformed JSON', async () => {
    await fs.mkdir(join(root, '.iris'));
    const path = join(root, '.iris', 'settings.json');
    await fs.writeFile(path, '{broken', 'utf8');
    const snapshot = await readProjectSettings(root);
    expect(snapshot.error).toContain('Invalid JSON');

    await expect(
      updateProjectToolbar(
        root,
        [{ icon: 'play', description: 'Run', command: 'run', terminal: 'iris' }],
        snapshot.revision,
      ),
    ).rejects.toMatchObject({ code: 'InvalidSettings' } satisfies Partial<ProjectSettingsError>);
    expect(await fs.readFile(path, 'utf8')).toBe('{broken');
  });

  it('does not parse or overwrite an oversized settings file', async () => {
    await fs.mkdir(join(root, '.iris'));
    const path = join(root, '.iris', 'settings.json');
    const oversized = ' '.repeat(MAX_PROJECT_SETTINGS_BYTES + 1);
    await fs.writeFile(path, oversized, 'utf8');

    const snapshot = await readProjectSettings(root);
    expect(snapshot.error).toContain('byte limit');

    await expect(
      updateProjectToolbar(
        root,
        [{ icon: 'play', description: 'Run', command: 'run', terminal: 'iris' }],
        snapshot.revision,
      ),
    ).rejects.toMatchObject({ code: 'ReadFailed' } satisfies Partial<ProjectSettingsError>);
    expect((await fs.stat(path)).size).toBe(MAX_PROJECT_SETTINGS_BYTES + 1);
  });

  it('keeps the previous file intact and cleans the temp file when atomic rename fails', async () => {
    const initial = await updateProjectPrompt(
      root,
      'Durable value',
      MISSING_PROJECT_SETTINGS_REVISION,
    );
    const path = join(root, '.iris', 'settings.json');
    const before = await fs.readFile(path, 'utf8');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated interruption'));

    await expect(
      updateProjectPrompt(root, 'Interrupted value', initial.revision),
    ).rejects.toMatchObject({ code: 'WriteFailed' } satisfies Partial<ProjectSettingsError>);
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect((await fs.readdir(join(root, '.iris'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
