import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createTempDataDir, removeTempDataDir } from './persistence';
import { ExternalPathError, ExternalPathManager } from './external-path-manager';

let root: string;
let manager: ExternalPathManager;

beforeEach(async () => {
  root = await createTempDataDir('iris-external-');
  await fs.mkdir(join(root, '.iris', 'issue'), { recursive: true });
  manager = new ExternalPathManager();
});

afterEach(async () => {
  await removeTempDataDir(root).catch(() => {});
});

describe('ExternalPathManager', () => {
  it('parses comments, BOM, relative paths, duplicates, and missing targets without losing lines', async () => {
    await fs.mkdir(join(root, 'shared'));
    await fs.writeFile(join(root, 'shared', 'spec.txt'), 'spec', 'utf8');
    await fs.writeFile(
      join(root, '.iris', 'external.txt'),
      '\uFEFF# references\r\n../shared/spec.txt\r\n../shared/spec.txt\r\nmissing.txt\r\n',
      'utf8',
    );

    const inventory = await manager.list(root, '.iris');

    expect(inventory.exists).toBe(true);
    expect(inventory.entries).toHaveLength(2);
    expect(inventory.entries[0]).toMatchObject({
      storedPath: '../shared/spec.txt',
      name: 'spec.txt',
      kind: 'file',
      exists: true,
      line: 1,
      error: null,
    });
    expect(inventory.entries[1]).toMatchObject({
      storedPath: 'missing.txt',
      exists: false,
      line: 3,
      error: 'missing',
    });
  });

  it('adds portable paths idempotently and removes only the exact current line', async () => {
    const target = join(root, 'reference.txt');
    await fs.writeFile(target, 'reference', 'utf8');
    await fs.writeFile(join(root, '.iris', 'external.txt'), '# keep\n\n', 'utf8');

    const added = await manager.add(root, '.iris', target);
    const duplicate = await manager.add(root, '.iris', target);
    expect(duplicate.line).toBe(added.line);
    expect(await fs.readFile(join(root, '.iris', 'external.txt'), 'utf8')).toBe(
      '# keep\n\n../reference.txt\n',
    );

    await manager.remove(root, {
      workspacePath: '.iris',
      storedPath: added.storedPath,
      line: added.line,
    });
    expect(await fs.readFile(join(root, '.iris', 'external.txt'), 'utf8')).toBe('# keep\n\n');
  });

  it('detects stale remove/open identities after an external edit', async () => {
    const target = join(root, 'reference.txt');
    await fs.writeFile(target, 'reference', 'utf8');
    const entry = await manager.add(root, '.iris', target);
    await fs.writeFile(join(root, '.iris', 'external.txt'), `# shifted\n${entry.storedPath}\n`, 'utf8');

    await expect(manager.remove(root, {
      workspacePath: '.iris',
      storedPath: entry.storedPath,
      line: entry.line,
    })).rejects.toMatchObject({ code: 'WriteConflict' } satisfies Partial<ExternalPathError>);

    await expect(manager.resolve(root, {
      workspacePath: '.iris',
      storedPath: entry.storedPath,
      line: entry.line,
    })).rejects.toMatchObject({ code: 'WriteConflict' } satisfies Partial<ExternalPathError>);
  });

  it('keeps missing manifests as an empty optional projection', async () => {
    await expect(manager.list(root, '.iris')).resolves.toMatchObject({
      exists: false,
      entries: [],
      diagnostics: [],
    });
  });

  it('round-trips the workspace itself and paths that look like comments', async () => {
    const workspace = join(root, '.iris');
    const target = join(workspace, '#reference.txt');
    await fs.writeFile(target, 'reference', 'utf8');

    const self = await manager.add(root, '.iris', workspace);
    const file = await manager.add(root, '.iris', target);

    expect(self.storedPath).toBe('.');
    expect(file.storedPath).toBe('./#reference.txt');
    expect((await manager.list(root, '.iris')).entries).toEqual([self, file]);
    await manager.remove(root, { workspacePath: '.iris', storedPath: file.storedPath, line: file.line });
    expect(await fs.readFile(target, 'utf8')).toBe('reference');
  });
});
