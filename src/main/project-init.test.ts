import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ProjectError, ProjectManager } from './project-manager';
import { createTempDataDir, removeTempDataDir } from './persistence';
import { parseProjectBlock, upsertProjectBlock } from './software-prompt';
import { readProjectSettings } from './project-settings';

const init = (manager: ProjectManager) => manager.initIris();

let dir: string;
let pm: ProjectManager;

beforeEach(async () => {
  dir = await createTempDataDir('iris-init-');
  await fs.mkdir(join(dir, '.iris'));
  pm = new ProjectManager();
  await pm.open(dir);
});

afterEach(async () => {
  await pm.close();
  await removeTempDataDir(dir).catch(() => {});
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('condition did not become true');
}

describe('initIris', () => {
  it('creates folders, software guidance, and versioned project settings', async () => {
    const result = await init(pm);
    expect(result.createdFolders.sort()).toEqual(
      ['.iris/issue', '.iris/misc', '.iris/report', '.iris/status'].sort(),
    );
    expect(result.agentsMd).toBe('created');
    await expect(fs.access(join(dir, '.iris', 'CONVENTIONS.md'))).rejects.toThrow();
    await expect(fs.access(join(dir, '.iris', 'styles.json'))).rejects.toThrow();
    expect(await readProjectSettings(dir)).toMatchObject({
      exists: true,
      settings: {
        version: 1,
        prompts: { project: '' },
        agentContext: { entries: ['AGENTS.md'] },
        toolbar: { actions: [] },
      },
    });

    const agents = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('<iris-software>');
    expect(agents).not.toMatch(/<iris-software\s+[^>]+>/);
    expect((await pm.scan()).hasIris).toBe(true);
    const preview = await pm.contextPreview();
    expect(preview.assembled).not.toContain('<iris-software');
    expect(preview.assembled).not.toContain('<iris-project');
    expect(preview.assembled).not.toContain('<iris-user');
  });

  it('is idempotent and creates no ad hoc backup', async () => {
    await init(pm);
    const before = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    const second = await init(pm);
    expect(second.createdFolders).toEqual([]);
    expect(second.agentsMd).toBe('already-has-section');
    expect(await fs.readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(before);
    await expect(fs.access(join(dir, 'AGENTS.md.bak'))).rejects.toThrow();
  });

  it('preserves prose and restores drift only when init is explicitly run', async () => {
    const source = '# My project\n\nhand-written intro\n\n<iris-software>\nold body\n</iris-software>\n';
    await fs.writeFile(join(dir, 'AGENTS.md'), source, 'utf8');
    expect((await pm.softwarePromptState()).entries[0]?.state).toBe('drifted');

    const result = await init(pm);
    expect(result.agentsMd).toBe('updated');
    const text = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(text.startsWith('# My project\n\nhand-written intro')).toBe(true);
    expect((await pm.softwarePromptState()).entries[0]?.state).toBe('ok');
  });

  it('does not enroll a later vendor entry until the user explicitly adds it', async () => {
    await fs.writeFile(join(dir, 'CLAUDE.md'), '# Claude\n', 'utf8');
    const result = await init(pm);
    expect(result.vendorEntries).toEqual([]);
    expect(await fs.readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# Claude\n');

    const settings = await readProjectSettings(dir);
    await pm.addPromptEntry('CLAUDE.md', settings.revision);
    expect(await fs.readFile(join(dir, 'CLAUDE.md'), 'utf8')).toContain('</iris-software>');
    expect((await readProjectSettings(dir)).settings.agentContext.entries).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
    ]);
    await expect(fs.access(join(dir, 'CLAUDE.md.bak'))).rejects.toThrow();
    await expect(fs.access(join(dir, 'GEMINI.md'))).rejects.toThrow();
  });

  it('recreates every missing participating entry during initialization', async () => {
    let settings = await readProjectSettings(dir);
    await pm.addPromptEntry('CLAUDE.md', settings.revision);
    settings = await readProjectSettings(dir);
    await pm.syncProjectPrompt('Use pnpm.', settings.revision);
    await fs.unlink(join(dir, 'CLAUDE.md'));

    const result = await init(pm);

    expect(result.vendorEntries).toContainEqual({ path: 'CLAUDE.md', action: 'created' });
    const claude = await fs.readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('<iris-software>');
    expect(parseProjectBlock(claude)?.body).toBe('Use pnpm.');
  });
});

describe('project prompt disk synchronization', () => {
  async function reopenLegacyProject(): Promise<void> {
    await pm.close();
    await fs.unlink(join(dir, '.iris', 'settings.json')).catch(() => {});
  }

  it('imports one unique legacy block into JSON and reports unsynchronized participants', async () => {
    await reopenLegacyProject();
    await fs.writeFile(
      join(dir, 'CLAUDE.md'),
      '# Claude\n\n<iris-project>\nUse pnpm.\n</iris-project>\n',
      'utf8',
    );
    await pm.open(dir);

    expect((await pm.softwarePromptState()).project).toMatchObject({
      state: 'drifted',
      text: 'Use pnpm.',
      conflicts: [],
    });
    expect((await readProjectSettings(dir)).settings.prompts.project).toBe('Use pnpm.');
    await pm.syncAllPromptEntries();
    const agents = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(parseProjectBlock(agents)?.body).toBe('Use pnpm.');
  });

  it('creates empty JSON when no legacy entry has a project prompt', async () => {
    await reopenLegacyProject();
    await fs.writeFile(join(dir, 'AGENTS.md'), '# Entry\n', 'utf8');
    await pm.open(dir);
    expect(await readProjectSettings(dir)).toMatchObject({
      exists: true,
      settings: { prompts: { project: '' } },
    });
  });

  it('reports divergent legacy blocks and preserves every file until selection', async () => {
    await reopenLegacyProject();
    const agents = '<iris-project>\nA\n</iris-project>\n';
    const claude = '<iris-project>\nB\n</iris-project>\n';
    await fs.writeFile(join(dir, 'AGENTS.md'), agents, 'utf8');
    await fs.writeFile(join(dir, 'CLAUDE.md'), claude, 'utf8');
    await pm.open(dir);

    const state = await pm.softwarePromptState();
    expect(state.project.state).toBe('conflict');
    expect(state.project.conflicts).toEqual([
      { path: 'AGENTS.md', text: 'A' },
      { path: 'CLAUDE.md', text: 'B' },
    ]);
    expect((await readProjectSettings(dir)).exists).toBe(false);
    expect(await fs.readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(agents);
    expect(await fs.readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe(claude);
    await expect(pm.assertProjectSettingsReady()).rejects.toMatchObject({
      code: 'PromptNotReady',
      domain: 'prompt',
      details: {
        repairable: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ layer: 'project', path: 'AGENTS.md', state: 'conflict' }),
          expect.objectContaining({ layer: 'project', path: 'CLAUDE.md', state: 'conflict' }),
        ]),
      },
    } satisfies Partial<ProjectError>);
  });

  it('a CAS save commits JSON first, fans out, and empty text removes every mirror', async () => {
    await fs.writeFile(join(dir, 'CLAUDE.md'), '# Claude\n', 'utf8');
    let settings = await readProjectSettings(dir);
    await pm.addPromptEntry('CLAUDE.md', settings.revision);
    settings = await readProjectSettings(dir);
    await pm.syncProjectPrompt('One rule\r\n', settings.revision);
    expect(parseProjectBlock(await fs.readFile(join(dir, 'AGENTS.md'), 'utf8'))?.body).toBe('One rule');
    expect(parseProjectBlock(await fs.readFile(join(dir, 'CLAUDE.md'), 'utf8'))?.body).toBe('One rule');
    expect((await readProjectSettings(dir)).settings.prompts.project).toBe('One rule');

    settings = await readProjectSettings(dir);
    await pm.syncProjectPrompt('', settings.revision);
    expect(parseProjectBlock(await fs.readFile(join(dir, 'AGENTS.md'), 'utf8'))).toBeNull();
    expect(parseProjectBlock(await fs.readFile(join(dir, 'CLAUDE.md'), 'utf8'))).toBeNull();
    expect((await pm.softwarePromptState()).project.state).toBe('missing');
  });

  it('marks an external entry edit as drift without importing it into JSON', async () => {
    await fs.writeFile(join(dir, 'CLAUDE.md'), '# Claude\n', 'utf8');
    let settings = await readProjectSettings(dir);
    await pm.addPromptEntry('CLAUDE.md', settings.revision);
    settings = await readProjectSettings(dir);
    await pm.syncProjectPrompt('Initial', settings.revision);
    await new Promise((resolve) => setTimeout(resolve, 350));

    const claudePath = join(dir, 'CLAUDE.md');
    const claude = await fs.readFile(claudePath, 'utf8');
    await fs.writeFile(claudePath, upsertProjectBlock(claude, 'External').text, 'utf8');

    await waitUntil(async () => (await pm.softwarePromptState()).project.state === 'drifted');
    expect((await readProjectSettings(dir)).settings.prompts.project).toBe('Initial');
    expect(parseProjectBlock(await fs.readFile(join(dir, 'AGENTS.md'), 'utf8'))?.body).toBe('Initial');
    await expect(pm.assertProjectSettingsReady()).rejects.toMatchObject({
      code: 'PromptNotReady',
      domain: 'prompt',
      details: {
        repairable: true,
        issues: expect.arrayContaining([
          expect.objectContaining({ layer: 'project', path: 'CLAUDE.md', state: 'drifted' }),
        ]),
      },
    } satisfies Partial<ProjectError>);
    await pm.restoreProjectPromptEntry('CLAUDE.md');
    await expect(pm.assertProjectSettingsReady()).resolves.toBeUndefined();
  });

  it('keeps a new vendor entry untouched until explicit enrollment', async () => {
    let settings = await readProjectSettings(dir);
    await pm.syncProjectPrompt('Canonical', settings.revision);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const claudePath = join(dir, 'CLAUDE.md');
    await fs.writeFile(claudePath, '# Claude\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await fs.readFile(claudePath, 'utf8')).toBe('# Claude\n');
    expect((await pm.softwarePromptState()).availableEntries).toContain('CLAUDE.md');

    settings = await readProjectSettings(dir);
    await pm.addPromptEntry('CLAUDE.md', settings.revision);
    expect(parseProjectBlock(await fs.readFile(claudePath, 'utf8'))?.body).toBe('Canonical');
    await fs.unlink(claudePath);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(fs.access(claudePath)).rejects.toThrow();
    expect((await pm.softwarePromptState()).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'CLAUDE.md', state: 'no-entry' }),
    ]));
  });

  it('audits an external JSON edit without silently rewriting entry files', async () => {
    const settingsPath = join(dir, '.iris', 'settings.json');
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
      version: 1;
      prompts: { project: string };
      toolbar: { actions: unknown[] };
    };
    settings.prompts.project = 'From JSON';
    await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    await waitUntil(async () => (await pm.softwarePromptState()).project.state === 'drifted');
    await expect(fs.access(join(dir, 'AGENTS.md'))).rejects.toThrow();
    await pm.syncAllPromptEntries();
    expect(parseProjectBlock(await fs.readFile(join(dir, 'AGENTS.md'), 'utf8'))?.body).toBe('From JSON');

    await fs.writeFile(settingsPath, '{broken', 'utf8');
    await waitUntil(async () => (await pm.softwarePromptState()).project.state === 'invalid-settings');
    const agentsPath = join(dir, 'AGENTS.md');
    const agents = await fs.readFile(agentsPath, 'utf8');
    await fs.writeFile(agentsPath, upsertProjectBlock(agents, 'Manual drift').text, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(parseProjectBlock(await fs.readFile(agentsPath, 'utf8'))?.body).toBe('Manual drift');
    await expect(pm.assertProjectSettingsReady()).rejects.toMatchObject({
      code: 'PromptNotReady',
      domain: 'prompt',
      details: {
        repairable: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ layer: 'settings', state: 'invalid-settings' }),
        ]),
      },
    } satisfies Partial<ProjectError>);
  });

  it('reports duplicate blocks and a single-entry projection failure without rolling back JSON', async () => {
    let settings = await readProjectSettings(dir);
    await pm.addPromptEntry('CLAUDE.md', settings.revision);
    await fs.unlink(join(dir, 'CLAUDE.md'));
    const duplicate = '<iris-project>\nOne\n</iris-project>\n<iris-project>\nTwo\n</iris-project>\n';
    await fs.writeFile(join(dir, 'AGENTS.md'), duplicate, 'utf8');
    await fs.mkdir(join(dir, 'CLAUDE.md'));
    settings = await readProjectSettings(dir);
    await pm.syncProjectPrompt('Canonical', settings.revision);

    expect((await readProjectSettings(dir)).settings.prompts.project).toBe('Canonical');
    const state = await pm.softwarePromptState();
    expect(state.project.state).toBe('partial');
    expect(state.project.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'AGENTS.md', state: 'write-failed' }),
      expect.objectContaining({ path: 'CLAUDE.md', state: 'write-failed' }),
    ]));
    expect(await fs.readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(duplicate);
  });

  it('ignores protocol-like prose outside managed blocks', async () => {
    await init(pm);
    const agentsPath = join(dir, 'AGENTS.md');
    const legacyProse = [
      '> old pointer <iris-software>',
      'This project is managed with Iris',
      '## Folder semantics',
      '## Working rules (invariant)',
      '</iris-software>',
      '',
    ].join('\n');
    await fs.appendFile(agentsPath, legacyProse, 'utf8');

    await expect(pm.assertProjectSettingsReady()).resolves.toBeUndefined();
    expect(await fs.readFile(agentsPath, 'utf8')).toContain(legacyProse);
  });

  it('stops syncing a vendor by removing both blocks and preserving foreign prose', async () => {
    await fs.writeFile(join(dir, 'CLAUDE.md'), '# Claude\n\nForeign prose\n', 'utf8');
    let settings = await readProjectSettings(dir);
    await pm.addPromptEntry('CLAUDE.md', settings.revision);
    settings = await readProjectSettings(dir);
    await pm.syncProjectPrompt('Use pnpm.', settings.revision);

    settings = await readProjectSettings(dir);
    await pm.removePromptEntry('CLAUDE.md', settings.revision);
    const source = await fs.readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(source).toContain('# Claude');
    expect(source).toContain('Foreign prose');
    expect(source).not.toContain('<iris-software>');
    expect(source).not.toContain('<iris-project>');
    expect((await readProjectSettings(dir)).settings.agentContext.entries).toEqual(['AGENTS.md']);
  });
});

describe('createWorkspace', () => {
  beforeEach(async () => {
    await init(pm);
  });

  it('creates standard and empty workspace shapes', async () => {
    await pm.createWorkspace({ parentPath: '.iris', name: 'spike-x', template: 'standard' });
    await pm.createWorkspace({ parentPath: '.iris', name: 'notes', template: 'empty' });
    const scan = await pm.scan();
    expect(scan.root!.children.map((child) => child.path)).toContain('.iris/spike-x');
    expect(scan.root!.children.map((child) => child.path)).not.toContain('.iris/notes');
  });

  it('rejects reserved and duplicate names', async () => {
    await expect(
      pm.createWorkspace({ parentPath: '.iris', name: 'status', template: 'standard' }),
    ).rejects.toMatchObject({ code: 'InvalidPayload' } satisfies Partial<ProjectError>);
    await expect(
      pm.createWorkspace({ parentPath: '.iris', name: 'a/b', template: 'standard' }),
    ).rejects.toMatchObject({ code: 'InvalidPayload' } satisfies Partial<ProjectError>);
    await pm.createWorkspace({ parentPath: '.iris', name: 'spike-x', template: 'standard' });
    await expect(
      pm.createWorkspace({ parentPath: '.iris', name: 'spike-x', template: 'standard' }),
    ).rejects.toMatchObject({ code: 'WriteFailed' } satisfies Partial<ProjectError>);
  });
});
