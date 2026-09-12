import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { AssetManager } from './asset-manager';
import { createTempDataDir, removeTempDataDir } from './persistence';

const docPath = '.iris/issue/测试 文档.md';
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

let dir: string;
let assets: AssetManager;

beforeEach(async () => {
  dir = await createTempDataDir('iris-assets-');
  await fs.mkdir(join(dir, '.iris', 'issue'), { recursive: true });
  await fs.writeFile(join(dir, docPath), '---\ntitle: assets\n---\n', 'utf8');
  assets = new AssetManager();
});

afterEach(async () => {
  await removeTempDataDir(dir).catch(() => {});
});

describe('AssetManager', () => {
  it('imports with the original readable name and allocates a simple unique suffix', async () => {
    const first = await assets.import(dir, {
      docPath,
      name: '流程 图.png',
      mimeType: 'image/png',
      bytes: png,
    });
    const duplicate = await assets.import(dir, {
      docPath,
      name: 'renamed.png',
      mimeType: 'image/png',
      bytes: png,
    });

    expect(first.path).toMatch(/测试 文档\.assets\/流程-图\.png$/u);
    expect(first.markdownUrl).toContain('%E6%B5%8B%E8%AF%95%20%E6%96%87%E6%A1%A3.assets');
    expect(duplicate.path).toMatch(/测试 文档\.assets\/renamed\.png$/u);
    expect(duplicate.path).not.toBe(first.path);

    const inventory = await assets.list(dir, docPath);
    expect(inventory.assets).toHaveLength(2);
  });

  it('audits inline and reference-style links without treating Markdown links as assets', async () => {
    const imported = await assets.import(dir, {
      docPath,
      name: 'diagram.png',
      mimeType: 'image/png',
      bytes: png,
    });
    await fs.mkdir(join(dir, 'build'), { recursive: true });
    await fs.writeFile(join(dir, 'build', 'legacy.png'), png);
    await fs.writeFile(
      join(dir, docPath),
      [
        `![one](${imported.markdownUrl})`,
        `![two][diagram]`,
        '',
        `[diagram]: ${imported.markdownUrl}`,
        `![missing](./%E6%B5%8B%E8%AF%95%20%E6%96%87%E6%A1%A3.assets/missing.png)`,
        `![legacy](../../build/legacy.png)`,
        `[other](./other.md)`,
      ].join('\n'),
      'utf8',
    );

    const inventory = await assets.list(dir, docPath);
    expect(inventory.assets).toHaveLength(2);
    expect(inventory.assets.find((asset) => asset.path === imported.path)).toMatchObject({ exists: true, referenceCount: 2 });
    expect(inventory.assets.find((asset) => asset.path === imported.path)?.referenceCount).toBe(2);
    expect(inventory.assets.some((asset) => asset.name === 'other.md')).toBe(false);
  });

  it('stores external file and directory associations in links.txt without treating the index as an asset', async () => {
    const external = join(dir, 'release.zip');
    const folder = join(dir, 'html-output');
    await fs.writeFile(external, 'zip placeholder', 'utf8');
    await fs.mkdir(folder);

    const first = await assets.addAssociated(dir, docPath, external);
    const second = await assets.addAssociated(dir, docPath, folder);
    await assets.addAssociated(dir, docPath, external);

    expect(first).toMatchObject({ name: 'release.zip', kind: 'file', exists: true });
    expect(second).toMatchObject({ name: 'html-output', kind: 'directory', exists: true });
    const linksPath = join(dir, '.iris', 'issue', '测试 文档.assets', 'links.txt');
    expect(await fs.readFile(linksPath, 'utf8')).toBe('release.zip\nhtml-output\n');

    const inventory = await assets.list(dir, docPath);
    expect(inventory.assets).toHaveLength(0);
    expect(inventory.associated).toHaveLength(2);
    expect(inventory.associated.map((entry) => entry.name)).toEqual(['release.zip', 'html-output']);

    await fs.rm(external);
    const missing = await assets.list(dir, docPath);
    expect(missing.associated.find((entry) => entry.name === 'release.zip')).toMatchObject({ exists: false, kind: null });

    await assets.removeAssociated(dir, docPath, external);
    expect(await fs.access(folder)).toBeUndefined();
    expect((await assets.list(dir, docPath)).associated).toHaveLength(1);
  });

});
