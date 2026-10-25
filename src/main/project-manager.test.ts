import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ProjectManager, ProjectError } from './project-manager';
import { createTempDataDir, removeTempDataDir } from './persistence';

let dir: string;
let manager: ProjectManager;
const relativePath = '.iris/issue/test.md';

beforeEach(async () => {
  dir = await createTempDataDir('iris-doc-write-');
  await fs.mkdir(join(dir, '.iris', 'issue'), { recursive: true });
  await fs.writeFile(join(dir, relativePath), 'old\n', 'utf8');
  manager = new ProjectManager();
  await manager.open(dir);
});

afterEach(async () => {
  await manager.close();
  await removeTempDataDir(dir).catch(() => {});
});

describe('ProjectManager document compare-and-swap', () => {
  it('rejects document reads through a directory link outside the project', async () => {
    const outside = await createTempDataDir('iris-doc-outside-');
    try {
      await fs.writeFile(join(outside, 'outside.md'), 'outside\n', 'utf8');
      await fs.symlink(outside, join(dir, '.iris', 'linked'), 'junction');

      await expect(manager.readDoc('.iris/linked/outside.md')).rejects.toMatchObject({
        code: 'ReadFailed',
      } satisfies Partial<ProjectError>);
    } finally {
      await removeTempDataDir(outside).catch(() => {});
    }
  });

  it('does not touch mtime when content is identical', async () => {
    const path = join(dir, relativePath);
    const fixed = new Date('2024-01-01T00:00:00.000Z');
    await fs.utimes(path, fixed, fixed);
    const before = await fs.stat(path);

    await manager.writeDoc(relativePath, 'old\n', 'old\n');

    const after = await fs.stat(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('rejects a stale baseline without overwriting external content', async () => {
    await fs.writeFile(join(dir, relativePath), 'external\n', 'utf8');

    await expect(manager.writeDoc(relativePath, 'local\n', 'old\n')).rejects.toMatchObject({
      code: 'WriteConflict',
    } satisfies Partial<ProjectError>);
    expect(await fs.readFile(join(dir, relativePath), 'utf8')).toBe('external\n');
  });

  it('allows an explicit overwrite with a null baseline', async () => {
    await fs.writeFile(join(dir, relativePath), 'external\n', 'utf8');

    await manager.writeDoc(relativePath, 'local\n', null);

    expect(await fs.readFile(join(dir, relativePath), 'utf8')).toBe('local\n');
  });
});

describe('ProjectManager document aggregate deletion', () => {
  it('deletes the document and companion assets as one staged aggregate', async () => {
    const companion = join(dir, '.iris', 'issue', 'test.assets');
    await fs.mkdir(companion);
    await fs.writeFile(join(companion, 'orphan--123456789abc.txt'), 'asset', 'utf8');

    const result = await manager.deleteDoc(relativePath);

    expect(result).toEqual({ path: relativePath, assetCount: 1 });
    await expect(fs.access(join(dir, relativePath))).rejects.toThrow();
    await expect(fs.access(companion)).rejects.toThrow();
  });

  it('restores both names when the trash operation fails', async () => {
    const companion = join(dir, '.iris', 'issue', 'test.assets');
    await fs.mkdir(companion);
    await fs.writeFile(join(companion, 'orphan--123456789abc.txt'), 'asset', 'utf8');

    await expect(
      manager.deleteDoc(relativePath, async () => {
        throw new Error('trash unavailable');
      }),
    ).rejects.toMatchObject({ code: 'WriteFailed' } satisfies Partial<ProjectError>);

    expect(await fs.readFile(join(dir, relativePath), 'utf8')).toBe('old\n');
    expect(await fs.readFile(join(companion, 'orphan--123456789abc.txt'), 'utf8')).toBe('asset');
  });
});

describe('ProjectManager HTML documents', () => {
  it('creates HTML pages only in report/ and avoids companion-dir collisions', async () => {
    const md = await manager.createDoc({ workspacePath: '.iris', type: 'report', title: '评审' });
    const page = await manager.createDoc({
      workspacePath: '.iris',
      type: 'report',
      title: '评审',
      format: 'html',
    });
    expect(md.path).toMatch(/^\.iris\/report\/\d{4}-\d{2}-\d{2}-评审\.md$/);
    // Same stem as the .md would share `<name>.assets/`, so the page gets -2.
    expect(page.path).toBe(md.path.replace(/\.md$/, '-2.html'));

    const content = await manager.readDoc(page.path);
    expect(content.frontmatter).toEqual({ title: '评审', status: 'Active' });
    expect(content.body).toBe(content.raw);
    expect(content.frontmatterBroken).toBe(false);

    await expect(
      manager.createDoc({ workspacePath: '.iris', type: 'issue', title: 'x', format: 'html' }),
    ).rejects.toMatchObject({ code: 'InvalidPayload' } satisfies Partial<ProjectError>);
  });

  it('scans and deletes HTML documents like Markdown ones', async () => {
    const page = '.iris/issue/page.html';
    await fs.writeFile(
      join(dir, page),
      '<html><head><title>Page</title><meta name="iris:status" content="Todo"></head><body>- [ ] not a task</body></html>',
      'utf8',
    );
    const { root } = await manager.scan();
    expect(root!.docs.find((doc) => doc.path === page)).toMatchObject({
      title: 'Page',
      status: 'Todo',
      todos: [],
      frontmatterBroken: false,
    });

    await expect(manager.deleteDoc(page)).resolves.toEqual({ path: page, assetCount: 0 });
    await expect(fs.access(join(dir, page))).rejects.toThrow();
  });
});
