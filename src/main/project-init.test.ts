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

/** Fixed version so the managed block is deterministic across runs. */
const V = '0.0.0-test';
const init = (pm: ProjectManager) => pm.initIris({ appVersion: V });

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
    const r = await init(pm);
    expect(r.createdFolders.sort()).toEqual(
      ['.iris/issue', '.iris/misc', '.iris/report', '.iris/status'].sort(),
    );
    expect(r.constitution).toBe('created');
    expect(r.constitutionSeed).toBe('software-default');
    expect(r.agentsMd).toBe('created');

    const constitution = await fs.readFile(join(dir, '.iris', 'CONVENTIONS.md'), 'utf8');
    expect(constitution).toContain('protocol: 1');
    // AGENTS.md carries the version-stamped managed block.
    const agents = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain(`<iris-software version="${V}"`);
    expect(agents).toContain('</iris-software>');

    const scan = await pm.scan();
    expect(scan.hasIris).toBe(true);
    expect(scan.constitution).toEqual({ exists: true, protocol: 1 });
  });

  it('is idempotent — second run touches nothing', async () => {
    await init(pm);
    const agentsBefore = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    const r2 = await init(pm);
    expect(r2.createdFolders).toEqual([]);
    expect(r2.constitution).toBe('already-exists');
    expect(r2.agentsMd).toBe('already-has-section');
    const agentsAfter = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(agentsAfter).toBe(agentsBefore);
    // Exactly one block (the body mentions the opening tag in prose, so count
    // the closing tag, which only the real block carries).
    expect(agentsAfter.split('</iris-software>').length).toBe(2);
  });

  it('appends the block to an existing AGENTS.md without rewriting it', async () => {
    await fs.writeFile(join(dir, 'AGENTS.md'), '# My project\n\nhand-written intro\n', 'utf8');
    const r = await init(pm);
    expect(r.agentsMd).toBe('appended');
    const text = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(text.startsWith('# My project\n\nhand-written intro')).toBe(true);
    expect(text).toContain(AGENTS_GUIDANCE_MARKER);
  });

  it('refreshes a stale (old-version) block in place', async () => {
    // A pre-existing AGENTS.md whose block was stamped by an older app version.
    await pm.initIris({ appVersion: '0.0.1-old' });
    const before = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(before).toContain('version="0.0.1-old"');
    const r = await init(pm);
    expect(r.agentsMd).toBe('updated');
    const after = await fs.readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(after).toContain(`version="${V}"`);
    expect(after.split('</iris-software>').length).toBe(2); // still exactly one
  });

  it('maintains the block in an existing vendor entry (CLAUDE.md), with a .bak', async () => {
    // Governance decision: Iris maintains the <iris-software> block in vendor
    // entries that already exist (it never creates an absent one).
    const claudeBody = '# CLAUDE.md\n\nhand-written claude guidance\n';
    await fs.writeFile(join(dir, 'CLAUDE.md'), claudeBody, 'utf8');

    const r = await init(pm);

    expect(r.agentsMd).toBe('created');
    expect(r.foreignEntries).toContain('CLAUDE.md');
    expect(r.vendorEntries).toContainEqual({ path: 'CLAUDE.md', action: 'created' });

    const claude = await fs.readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude.startsWith('# CLAUDE.md\n\nhand-written claude guidance')).toBe(true);
    expect(claude).toContain('</iris-software>');
    // Original content preserved as a .bak before the first write.
    expect(await fs.readFile(join(dir, 'CLAUDE.md.bak'), 'utf8')).toBe(claudeBody);
  });

  it('does not create an absent vendor entry', async () => {
    await init(pm);
    await expect(fs.access(join(dir, 'CLAUDE.md'))).rejects.toThrow();
  });

  it('reports no vendor entries on a bare project', async () => {
    const r = await init(pm);
    expect(r.foreignEntries).toEqual([]);
    expect(r.vendorEntries).toEqual([]);
  });

  it('prefers the user-default constitution when one is supplied', async () => {
    const userDefault = '---\nprotocol: 1\n---\n\n# My house constitution\n';
    const r = await pm.initIris({ appVersion: V, userConstitution: userDefault });
    expect(r.constitution).toBe('created');
    expect(r.constitutionSeed).toBe('user-default');
    expect(await fs.readFile(join(dir, '.iris', 'CONVENTIONS.md'), 'utf8')).toBe(userDefault);
  });

  it('never overwrites an existing constitution', async () => {
    await fs.mkdir(join(dir, '.iris'), { recursive: true });
    await fs.writeFile(join(dir, '.iris', 'CONVENTIONS.md'), 'HUMAN OWNED\n', 'utf8');
    const r = await init(pm);
    expect(r.constitution).toBe('already-exists');
    expect(await fs.readFile(join(dir, '.iris', 'CONVENTIONS.md'), 'utf8')).toBe('HUMAN OWNED\n');
  });
});

describe('createWorkspace', () => {
  beforeEach(async () => {
    await init(pm);
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
