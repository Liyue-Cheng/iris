/**
 * project.init / workspace.create unit tests against a temp dir: the
 * scaffold is idempotent, never clobbers human-authored files, and rejects
 * reserved workspace names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ProjectManager } from './project-manager';
import { createTempDataDir, removeTempDataDir } from './persistence';
import { AGENTS_GUIDANCE_MARKER } from './iris-templates';

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

describe('initIris', () => {
  it('creates the full scaffold on a bare project', async () => {
    const r = await pm.initIris();
    expect(r.createdFolders.sort()).toEqual(
      ['.iris/issue', '.iris/misc', '.iris/report', '.iris/status'].sort(),
    );
    expect(r.constitution).toBe('created');
    expect(r.agentsMd).toBe('created');

    const constitution = await fs.readFile(join(dir, '.iris', 'CONVENTIONS.md'), 'utf8');
    expect(constitution).toContain('protocol: 1');
    const scan = await pm.scan();
    expect(scan.hasIris).toBe(true);
    expect(scan.constitution).toEqual({ exists: true, protocol: 1 });
  });

  it('is idempotent — second run touches nothing', async () => {
    await pm.initIris();
    const agentsBefore = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    const r2 = await pm.initIris();
    expect(r2.createdFolders).toEqual([]);
    expect(r2.constitution).toBe('already-exists');
    expect(r2.agentsMd).toBe('already-has-section');
    const agentsAfter = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(agentsAfter).toBe(agentsBefore);
    expect(agentsAfter.split(AGENTS_GUIDANCE_MARKER).length).toBe(2); // exactly one section
  });

  it('appends to an existing AGENTS.md without rewriting it', async () => {
    await fs.writeFile(join(dir, 'AGENTS.md'), '# My project\n\nhand-written intro\n', 'utf8');
    const r = await pm.initIris();
    expect(r.agentsMd).toBe('appended');
    const text = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(text.startsWith('# My project')).toBe(true);
    expect(text).toContain(AGENTS_GUIDANCE_MARKER);
  });

  it('never overwrites an existing constitution', async () => {
    await fs.mkdir(join(dir, '.iris'), { recursive: true });
    await fs.writeFile(join(dir, '.iris', 'CONVENTIONS.md'), 'HUMAN OWNED\n', 'utf8');
    const r = await pm.initIris();
    expect(r.constitution).toBe('already-exists');
    expect(await fs.readFile(join(dir, '.iris', 'CONVENTIONS.md'), 'utf8')).toBe('HUMAN OWNED\n');
  });
});

describe('createWorkspace', () => {
  beforeEach(async () => {
    await pm.initIris();
  });

  it('standard template creates the four typed folders', async () => {
    const r = await pm.createWorkspace({
      parentPath: '.iris',
      name: 'spike-x',
      template: 'standard',
    });
    expect(r.path).toBe('.iris/spike-x');
    const scan = await pm.scan();
    expect(scan.root!.children.map((c) => c.path)).toContain('.iris/spike-x');
  });

  it('empty template creates a bare folder (not yet a workspace)', async () => {
    await pm.createWorkspace({ parentPath: '.iris', name: 'notes', template: 'empty' });
    const entries = await fs.readdir(join(dir, '.iris', 'notes'));
    expect(entries).toEqual([]);
    const scan = await pm.scan();
    expect(scan.root!.children.map((c) => c.path)).not.toContain('.iris/notes');
  });

  it('rejects reserved typed-folder names and illegal characters', async () => {
    await expect(
      pm.createWorkspace({ parentPath: '.iris', name: 'status', template: 'standard' }),
    ).rejects.toThrow(/保留名/);
    await expect(
      pm.createWorkspace({ parentPath: '.iris', name: 'a/b', template: 'standard' }),
    ).rejects.toThrow(/不合法/);
    await expect(
      pm.createWorkspace({ parentPath: '.iris', name: 'spike-x', template: 'standard' }),
    ).resolves.toBeTruthy();
    await expect(
      pm.createWorkspace({ parentPath: '.iris', name: 'spike-x', template: 'standard' }),
    ).rejects.toThrow(/已存在/);
  });
});
