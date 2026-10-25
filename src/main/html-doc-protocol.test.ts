import { describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { session } from 'electron';

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd(), isPackaged: false },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: { defaultSession: {
    protocol: { handle: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  } },
  shell: {},
}));

vi.mock('node:fs', () => ({
  promises: { realpath: vi.fn(), stat: vi.fn(), readFile: vi.fn() },
}));

const {
  buildPreviewCsp,
  grantHtmlPreview,
  installHtmlDocProtocol,
  previewMimeType,
  resolvePreviewPath,
  revokeHtmlPreview,
  rootForPreviewToken,
} = await import('./html-doc-protocol');

const root = resolve('/tmp/iris-project');

describe('resolvePreviewPath', () => {
  it('maps encoded URL paths inside the project root', () => {
    expect(resolvePreviewPath(root, '/.iris/report/a%20b.html')).toBe(join(root, '.iris/report/a b.html'));
    expect(resolvePreviewPath(root, '/.iris/report/%E6%8A%A5%E5%91%8A.html')).toBe(
      join(root, '.iris/report/报告.html'),
    );
  });

  it('rejects escapes, encoded separators, and the root itself', () => {
    expect(resolvePreviewPath(root, '/../secret.txt')).toBeNull();
    expect(resolvePreviewPath(root, '/.iris/%2e%2e/%2e%2e/../x')).toBeNull();
    expect(resolvePreviewPath(root, '/a%2F..%2F..%2Fx')).toBeNull();
    expect(resolvePreviewPath(root, '/a%5C..%5Cx')).toBeNull();
    expect(resolvePreviewPath(root, '/')).toBeNull();
    expect(resolvePreviewPath(root, '/%E0%A4%A')).toBeNull();
  });
});

describe('buildPreviewCsp', () => {
  it('keeps previews offline and script-free when both are disabled', () => {
    const csp = buildPreviewCsp({ scripts: false, network: false });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('https:');
  });

  it('opens remote origins only when network is enabled', () => {
    const csp = buildPreviewCsp({ scripts: true, network: true });
    expect(csp).toContain("script-src iris-doc: blob: 'unsafe-inline' 'unsafe-eval' https: http:");
    expect(csp).toContain('connect-src https: http: wss: ws:');
    const offline = buildPreviewCsp({ scripts: true, network: false });
    expect(offline).toContain("script-src iris-doc: blob: 'unsafe-inline' 'unsafe-eval'");
    expect(offline).toContain("connect-src 'none'");
    expect(offline).not.toContain('https:');
  });
});

describe('preview grants', () => {
  it('reuses a token per scope and retires it on switch or revoke', () => {
    const owner = {};
    let live: { root: string; generation: number } | null = { root, generation: 1 };
    const base = grantHtmlPreview(owner, { root, generation: 1 }, () => live);
    expect(base).toMatch(/^iris-doc:\/\/[0-9a-f]{32}\/$/);
    const token = new URL(base).hostname;
    expect(grantHtmlPreview(owner, { root, generation: 1 }, () => live)).toBe(base);
    expect(rootForPreviewToken(token)).toBe(root);

    live = { root, generation: 2 };
    expect(rootForPreviewToken(token)).toBeNull();

    const next = grantHtmlPreview(owner, { root, generation: 2 }, () => live);
    expect(next).not.toBe(base);
    expect(rootForPreviewToken(new URL(next).hostname)).toBe(root);
    revokeHtmlPreview(owner);
    expect(rootForPreviewToken(new URL(next).hostname)).toBeNull();
    expect(rootForPreviewToken('unknown')).toBeNull();
  });
});

describe('previewMimeType', () => {
  it('serves HTML and common assets with explicit types', () => {
    expect(previewMimeType('a.HTML')).toBe('text/html; charset=utf-8');
    expect(previewMimeType('x.svg')).toBe('image/svg+xml');
    expect(previewMimeType('x.unknown')).toBe('application/octet-stream');
  });
});

describe('preview request realpath boundary', () => {
  it.skipIf(process.platform !== 'win32')('rejects a local link resolved onto a UNC share', async () => {
    const owner = {};
    const scope = { root: 'C:\\project', generation: 1 };
    const base = grantHtmlPreview(owner, scope, () => scope);
    installHtmlDocProtocol(() => ({ scripts: true, network: false }));
    vi.mocked(fs.realpath).mockImplementation(async (file) =>
      String(file) === scope.root ? scope.root : '\\\\server\\share\\secret.txt',
    );
    vi.mocked(fs.stat).mockResolvedValue({
      isFile: () => true, size: 6,
    } as Awaited<ReturnType<typeof fs.stat>>);
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('secret'));
    vi.mocked(fs.readFile).mockClear();
    const handler = vi.mocked(session.defaultSession.protocol.handle).mock.calls.at(-1)![1];
    const response = await handler(new Request(base + 'linked/secret.txt'));
    expect(response.status).toBe(404);
    expect(fs.readFile).not.toHaveBeenCalled();
    revokeHtmlPreview(owner);
  });
});
