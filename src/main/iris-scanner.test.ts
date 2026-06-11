/**
 * Scanner unit tests against fixtures/sample-project — the protocol's
 * deterministic rendering rules, pinned:
 *   name-is-type (recursive) / workspace inference / nearest-workspace
 *   ownership / archive-inside-report / frontmatter tolerance.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { scanProject, scanRawTree, parseFrontmatter } from './iris-scanner';
import type { IrisWorkspace } from '@shared/types';

const FIXTURE = resolve(__dirname, '../../fixtures/sample-project');

function byPath(ws: IrisWorkspace, rel: string): IrisWorkspace | undefined {
  if (ws.path === rel) return ws;
  for (const c of ws.children) {
    const hit = byPath(c, rel);
    if (hit) return hit;
  }
  return undefined;
}

describe('scanProject on the sample fixture', () => {
  it('finds the root workspace and infers nested workspaces (no manifest)', async () => {
    const result = await scanProject(FIXTURE);
    expect(result.hasIris).toBe(true);
    expect(result.root).not.toBeNull();
    const root = result.root!;

    expect(root.path).toBe('.iris');
    // root workspace displays the project name
    expect(root.name).toBe('sample-project');

    const childPaths = root.children.map((c) => c.path).sort();
    expect(childPaths).toEqual(['.iris/report/spike-cache', '.iris/spike-auth']);
  });

  it('types docs by the nearest typed folder, including free-form subdirs', async () => {
    const { root } = await scanProject(FIXTURE);
    const rootDocs = root!.docs;

    const weekly = rootDocs.find((d) => d.path === '.iris/report/2026-q2/weekly-23.md');
    expect(weekly).toBeDefined();
    expect(weekly!.type).toBe('report');
    expect(weekly!.workspacePath).toBe('.iris');

    const types = new Set(rootDocs.map((d) => d.type));
    expect(types).toEqual(new Set(['status', 'issue', 'report', 'misc']));
  });

  it('assigns sub-workspace docs to the sub-workspace, not the root', async () => {
    const { root } = await scanProject(FIXTURE);
    const spike = byPath(root!, '.iris/spike-auth')!;
    expect(spike.archived).toBe(false);

    const spikePaths = spike.docs.map((d) => d.path);
    expect(spikePaths).toContain('.iris/spike-auth/issue/2026-06-10-token-expiry.md');

    const rootPaths = root!.docs.map((d) => d.path);
    expect(rootPaths.some((p) => p.startsWith('.iris/spike-auth/'))).toBe(false);
  });

  it('marks a workspace inside report/ as archived (the archive gesture)', async () => {
    const { root } = await scanProject(FIXTURE);
    const cache = byPath(root!, '.iris/report/spike-cache')!;
    expect(cache.archived).toBe(true);
    expect(cache.docs.map((d) => d.path)).toContain(
      '.iris/report/spike-cache/status/conclusion.md',
    );
    // and its docs do NOT leak into the root's report docs
    expect(root!.docs.some((d) => d.path.startsWith('.iris/report/spike-cache/'))).toBe(false);
  });

  it('passes soft status values through verbatim', async () => {
    const { root } = await scanProject(FIXTURE);
    const deviant = root!.docs.find(
      (d) => d.path === '.iris/issue/2026-06-09-upstream-dependency.md',
    )!;
    expect(deviant.status).toBe('等待外部依赖');
  });

  it('degrades broken frontmatter without crashing or hiding the doc', async () => {
    const { root } = await scanProject(FIXTURE);
    const broken = root!.docs.find((d) => d.path === '.iris/issue/broken-frontmatter.md')!;
    expect(broken.frontmatterBroken).toBe(true);
    expect(broken.frontmatter).toBeNull();
    expect(broken.title).toBeNull();
  });

  it('ignores non-md files and loose workspace-root files in the lens model', async () => {
    const { root } = await scanProject(FIXTURE);
    const allDocs: string[] = [];
    const collect = (ws: IrisWorkspace): void => {
      allDocs.push(...ws.docs.map((d) => d.path));
      ws.children.forEach(collect);
    };
    collect(root!);

    expect(allDocs.some((p) => p.endsWith('.txt'))).toBe(false);
    expect(allDocs).not.toContain('.iris/CONVENTIONS.md');
    expect(allDocs).not.toContain('.iris/spike-auth/index.md');
  });

  it('reports hasIris=false gracefully for a project without .iris/', async () => {
    const result = await scanProject(resolve(__dirname, '../../src'));
    expect(result.hasIris).toBe(false);
    expect(result.root).toBeNull();
  });
});

describe('scanRawTree', () => {
  it('exposes everything, including non-md files', async () => {
    const tree = await scanRawTree(FIXTURE);
    expect(tree).not.toBeNull();
    const flat: string[] = [];
    const walk = (n: NonNullable<typeof tree>): void => {
      flat.push(n.path);
      n.children?.forEach(walk);
    };
    walk(tree!);
    expect(flat).toContain('.iris/misc/not-markdown.txt');
    expect(flat).toContain('.iris/CONVENTIONS.md');
  });
});

describe('parseFrontmatter', () => {
  it('absent frontmatter → null, not broken', () => {
    expect(parseFrontmatter('# just a doc\n')).toEqual({ frontmatter: null, broken: false });
  });
  it('valid frontmatter → parsed', () => {
    const r = parseFrontmatter('---\ntitle: hi\n---\nbody');
    expect(r.broken).toBe(false);
    expect(r.frontmatter).toEqual({ title: 'hi' });
  });
  it('broken YAML → broken flag, no throw', () => {
    const r = parseFrontmatter('---\ntitle: [oops\n  {{\n---\nbody');
    expect(r.broken).toBe(true);
    expect(r.frontmatter).toBeNull();
  });
});
