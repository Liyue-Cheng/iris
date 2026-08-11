import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDataDir, JsonStore, removeTempDataDir } from './persistence';
import {
  rotateFileOnce,
  rotatedFilePath,
  siblingTempPath,
  writeFileAtomic,
} from './atomic-write';

describe('atomic file paths', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempDataDir('iris-atomic-write-');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDataDir(root);
  });

  it('keeps the target name and uses tmp as the final extension', () => {
    const target = join(root, 'settings.json');
    const paths = Array.from({ length: 1_000 }, () => siblingTempPath(target));

    expect(new Set(paths)).toHaveLength(paths.length);
    for (const path of paths) {
      expect(basename(path)).toMatch(/^settings\.json\.\d+\.[0-9a-f-]{36}\.tmp$/u);
    }
  });

  it('keeps the semantic extension last for rotated files', () => {
    expect(rotatedFilePath(join(root, 'main-debug.log'))).toBe(join(root, 'main-debug.1.log'));
    expect(rotatedFilePath(join(root, 'diagnostics'), 2)).toBe(join(root, 'diagnostics.2'));
  });

  it('rotates on disk while replacing the previous generation', async () => {
    const target = join(root, 'main-debug.log');
    const rotated = join(root, 'main-debug.1.log');
    await fs.writeFile(target, 'current', 'utf8');
    await fs.writeFile(rotated, 'previous', 'utf8');

    expect(rotateFileOnce(target)).toBe(rotated);

    expect(await fs.readFile(rotated, 'utf8')).toBe('current');
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('replaces the target and removes the temporary file after success', async () => {
    const target = join(root, '文档.md');
    await fs.writeFile(target, 'old', 'utf8');

    await writeFileAtomic(target, 'new');

    expect(await fs.readFile(target, 'utf8')).toBe('new');
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the target intact and cleans only its own temp file when replacement fails', async () => {
    const target = join(root, 'settings.json');
    await fs.writeFile(target, 'old', 'utf8');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated replacement failure'));

    await expect(writeFileAtomic(target, 'new')).rejects.toThrow('simulated replacement failure');

    expect(await fs.readFile(target, 'utf8')).toBe('old');
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('creates collision-free sibling files for concurrent writes', async () => {
    const targets = Array.from({ length: 32 }, (_, index) => join(root, `file-${index}.md`));

    await Promise.all(targets.map((target, index) => writeFileAtomic(target, `value-${index}`)));

    await expect(Promise.all(targets.map((target) => fs.readFile(target, 'utf8')))).resolves.toEqual(
      targets.map((_, index) => `value-${index}`),
    );
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('preserves a backup that can recover a corrupted user settings file', async () => {
    const target = join(root, 'settings.json');
    await fs.writeFile(target, JSON.stringify({ value: 'durable' }), 'utf8');
    const store = new JsonStore<{ value: string }>(target, 0);
    store.set({ value: 'new' });
    await store.flush();
    await fs.writeFile(target, '{broken', 'utf8');

    const recovered = await new JsonStore<{ value: string }>(target).load({ value: 'default' });

    expect(recovered).toEqual({ value: { value: 'durable' }, source: 'bak' });
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
