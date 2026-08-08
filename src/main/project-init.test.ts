import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ProjectManager } from './project-manager';
import { createTempDataDir, removeTempDataDir } from './persistence';
import { parseProjectBlock, upsertProjectBlock } from './software-prompt';

const init = (manager: ProjectManager) => manager.initIris();

let dir: string;
let pm: ProjectManager;

beforeEach(async () => {
  dir = await createTempDataDir('iris-init-');
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
  it('creates folders and an attribute-free software block, but no project prompt file', async () => {
    const result = await init(pm);
    expect(result.createdFolders.sort()).toEqual(
      ['.iris/issue', '.iris/misc', '.iris/report', '.iris/status'].sort(),
    );
    expect(result.agentsMd).toBe('created');
    await expect(fs.access(join(dir, '.iris', 'CONVENTIONS.md'))).rejects.toThrow();
    await expect(fs.access(join(dir, '.iris', 'styles.json'))).rejects.toThrow();

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

  it('maintains existing vendor entries without creating absent ones or backups', async () => {
    await fs.writeFile(join(dir, 'CLAUDE.md'), '# Claude\n', 'utf8');
    const result = await init(pm);
    expect(result.vendorEntries).toContainEqual({ path: 'CLAUDE.md', action: 'created' });
    expect(await fs.readFile(join(dir, 'CLAUDE.md'), 'utf8')).toContain('</iris-software>');
    await expect(fs.access(join(dir, 'CLAUDE.md.bak'))).rejects.toThrow();
    await expect(fs.access(join(dir, 'GEMINI.md'))).rejects.toThrow();
  });
});

describe('project prompt disk synchronization', () => {
  it('imports one disk block on open and mirrors it to the standard entry', async () => {
    await pm.close();
    await fs.writeFile(
      join(dir, 'CLAUDE.md'),
      '# Claude\n\n<iris-project>\nUse pnpm.\n</iris-project>\n',
      'utf8',
    );
    await pm.open(dir);

    expect((await pm.softwarePromptState()).project).toMatchObject({
      state: 'synced',
      text: 'Use pnpm.',
      conflicts: [],
    });
    const agents = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(parseProjectBlock(agents)?.body).toBe('Use pnpm.');
  });

  it('reports divergent entry blocks and does not overwrite either', async () => {
    await pm.close();
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
    expect(await fs.readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(agents);
    expect(await fs.readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe(claude);
  });

  it('a user save resolves conflict, fans out, and empty text removes every block', async () => {
    await fs.writeFile(join(dir, 'CLAUDE.md'), '# Claude\n', 'utf8');
    await pm.syncProjectPrompt('One rule\r\n');
    expect(parseProjectBlock(await fs.readFile(join(dir, 'AGENTS.md'), 'utf8'))?.body).toBe('One rule');
    expect(parseProjectBlock(await fs.readFile(join(dir, 'CLAUDE.md'), 'utf8'))?.body).toBe('One rule');

    await pm.syncProjectPrompt('');
    expect(parseProjectBlock(await fs.readFile(join(dir, 'AGENTS.md'), 'utf8'))).toBeNull();
    expect(parseProjectBlock(await fs.readFile(join(dir, 'CLAUDE.md'), 'utf8'))).toBeNull();
    expect((await pm.softwarePromptState()).project.state).toBe('missing');
  });

  it('imports a single external edit during a session and mirrors it', async () => {
    await fs.writeFile(join(dir, 'CLAUDE.md'), '# Claude\n', 'utf8');
    await pm.syncProjectPrompt('Initial');
    await new Promise((resolve) => setTimeout(resolve, 350));

    const claudePath = join(dir, 'CLAUDE.md');
    const claude = await fs.readFile(claudePath, 'utf8');
    await fs.writeFile(claudePath, upsertProjectBlock(claude, 'External').text, 'utf8');

    await waitUntil(async () => (await pm.softwarePromptState()).project.text === 'External');
    expect(parseProjectBlock(await fs.readFile(join(dir, 'AGENTS.md'), 'utf8'))?.body).toBe('External');
  });

  it('stops on distinct concurrent external edits instead of choosing a winner', async () => {
    await fs.writeFile(join(dir, 'CLAUDE.md'), '# Claude\n', 'utf8');
    await pm.syncProjectPrompt('Initial');
    await new Promise((resolve) => setTimeout(resolve, 350));

    const agentsPath = join(dir, 'AGENTS.md');
    const claudePath = join(dir, 'CLAUDE.md');
    const [agents, claude] = await Promise.all([
      fs.readFile(agentsPath, 'utf8'),
      fs.readFile(claudePath, 'utf8'),
    ]);
    await Promise.all([
      fs.writeFile(agentsPath, upsertProjectBlock(agents, 'External A').text, 'utf8'),
      fs.writeFile(claudePath, upsertProjectBlock(claude, 'External B').text, 'utf8'),
    ]);

    await waitUntil(async () => (await pm.softwarePromptState()).project.state === 'conflict');
    const state = await pm.softwarePromptState();
    expect(state.project.conflicts.map((item) => item.text).sort()).toEqual([
      'External A',
      'External B',
    ]);
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
    await expect(pm.createWorkspace({ parentPath: '.iris', name: 'status', template: 'standard' })).rejects.toThrow(/保留名/);
    await expect(pm.createWorkspace({ parentPath: '.iris', name: 'a/b', template: 'standard' })).rejects.toThrow(/不合法/);
    await pm.createWorkspace({ parentPath: '.iris', name: 'spike-x', template: 'standard' });
    await expect(pm.createWorkspace({ parentPath: '.iris', name: 'spike-x', template: 'standard' })).rejects.toThrow(/已存在/);
  });
});
