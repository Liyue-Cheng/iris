import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { AssetError, AssetManager } from './asset-manager';
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
  it('imports by content hash, emits a portable URL and reuses duplicate bytes', async () => {
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

    expect(first.path).toMatch(/测试 文档\.assets\/流程-图--[a-f\d]{12}\.png$/u);
    expect(first.markdownUrl).toContain('%E6%B5%8B%E8%AF%95%20%E6%96%87%E6%A1%A3.assets');
    expect(first.reused).toBe(false);
    expect(duplicate).toMatchObject({ path: first.path, markdownUrl: first.markdownUrl, reused: true });

    const inventory = await assets.list(dir, docPath);
    expect(inventory.counts).toEqual({ referenced: 0, orphan: 1, missing: 0, unmanaged: 0 });
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
    expect(inventory.counts).toEqual({ referenced: 1, orphan: 0, missing: 1, unmanaged: 1 });
    expect(inventory.assets.find((asset) => asset.path === imported.path)?.referenceCount).toBe(2);
    expect(inventory.assets.some((asset) => asset.name === 'other.md')).toBe(false);
  });

  it('rejects SVG and files that claim an image type without a raster signature', async () => {
    await expect(
      assets.import(dir, {
        docPath,
        name: 'active.svg',
        mimeType: 'image/svg+xml',
        bytes: new TextEncoder().encode('<svg><script /></svg>'),
      }),
    ).rejects.toMatchObject({ code: 'UnsupportedType' } satisfies Partial<AssetError>);

    await expect(
      assets.import(dir, {
        docPath,
        name: 'fake.png',
        mimeType: 'image/png',
        bytes: new TextEncoder().encode('not an image'),
      }),
    ).rejects.toMatchObject({ code: 'UnsupportedType' } satisfies Partial<AssetError>);
  });

  it('only trashes orphan files and removes an empty companion directory', async () => {
    const imported = await assets.import(dir, {
      docPath,
      name: 'orphan.png',
      mimeType: 'image/png',
      bytes: png,
    });
    await assets.trash(dir, docPath, imported.path, (path) => fs.rm(path));
    await expect(fs.access(join(dir, imported.path))).rejects.toThrow();
    await expect(fs.access(join(dir, '.iris', 'issue', '测试 文档.assets'))).rejects.toThrow();

    const referenced = await assets.import(dir, {
      docPath,
      name: 'kept.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([...png, 4]),
    });
    await fs.writeFile(join(dir, docPath), `![kept](${referenced.markdownUrl})\n`, 'utf8');
    await expect(
      assets.trash(dir, docPath, referenced.path, (path) => fs.rm(path)),
    ).rejects.toMatchObject({ code: 'Referenced' } satisfies Partial<AssetError>);
  });

  it('adopts legacy local and data-image URLs with source-local Markdown edits', async () => {
    await fs.mkdir(join(dir, 'build'), { recursive: true });
    await fs.writeFile(join(dir, 'build', 'legacy.png'), png);
    const dataUrl = `data:image/png;base64,${Buffer.from([...png, 9]).toString('base64')}`;
    await fs.writeFile(
      join(dir, docPath),
      `before\n\n![legacy](../../build/legacy.png)\n\n![embedded](${dataUrl})\n\nafter\n`,
      'utf8',
    );

    await assets.adopt(dir, docPath, '../../build/legacy.png');
    await assets.adopt(dir, docPath, dataUrl);

    const rewritten = await fs.readFile(join(dir, docPath), 'utf8');
    expect(rewritten).toContain('before\n\n![legacy](./%E6%B5%8B%E8%AF%95%20%E6%96%87%E6%A1%A3.assets/');
    expect(rewritten).toContain('\n\nafter\n');
    expect(rewritten).not.toContain('../../build/legacy.png');
    expect(rewritten).not.toContain('data:image/');
    expect((await assets.list(dir, docPath)).counts).toEqual({
      referenced: 2,
      orphan: 0,
      missing: 0,
      unmanaged: 0,
    });
  });
});
