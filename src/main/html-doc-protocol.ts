/**
 * @file src/main/html-doc-protocol.ts
 * @purpose Serve project files to the sandboxed HTML document preview
 *   (issue 2026-10-25-支持HTML).
 *
 * The preview is an `<iframe sandbox>` WITHOUT allow-same-origin, loaded
 * from `iris-doc://<token>/<project-relative path>` rather than `srcdoc`:
 *   - srcdoc inherits the Iris renderer CSP (inline scripts would die) and
 *     has an about:srcdoc base URL (relative `./x.assets/…` links would die);
 *   - a real URL per file makes relative resources resolve naturally, and
 *     every response carries its own CSP derived from the user's settings.
 *
 * The host is an unguessable per-(window, project generation) token, never a
 * path: a preview can only read inside the project its window has open, and
 * a project switch or window close retires the token. No CORS headers are
 * sent, so preview scripts cannot read other project files' bytes — they can
 * only embed them the way any page embeds subresources.
 */
import { protocol, session, shell, type WebContents } from 'electron';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { HTML_DOC_SCHEME } from '@shared/html-doc';
import { logger } from './logger';

export interface HtmlPreviewScope {
  root: string;
  generation: number;
}

export interface HtmlPreviewPolicy {
  scripts: boolean;
  network: boolean;
}

/** Must run before app `ready` (Electron requirement). */
export function registerHtmlDocScheme(): void {
  protocol.registerSchemesAsPrivileged([
    // standard: host/path URL semantics so relative links resolve.
    // secure: treated like https (no mixed-content downgrade warnings).
    // No corsEnabled / supportFetchAPI: preview scripts cannot fetch() files.
    { scheme: HTML_DOC_SCHEME, privileges: { standard: true, secure: true, stream: true } },
  ]);
}

// ──────────────────────────────────────────────────────────────────
// Grants: token → live project scope
// ──────────────────────────────────────────────────────────────────

interface Grant {
  scope: HtmlPreviewScope;
  live: () => HtmlPreviewScope | null;
}

const grants = new Map<string, Grant>();
const ownerTokens = new WeakMap<object, string>();

/** Base URL (`iris-doc://<token>/`) for one window's current project. The
 *  token is reused while the scope is unchanged and replaced otherwise. */
export function grantHtmlPreview(
  owner: object,
  scope: HtmlPreviewScope,
  live: () => HtmlPreviewScope | null,
): string {
  const existing = ownerTokens.get(owner);
  const current = existing ? grants.get(existing) : undefined;
  if (
    existing && current &&
    current.scope.root === scope.root && current.scope.generation === scope.generation
  ) {
    return `${HTML_DOC_SCHEME}://${existing}/`;
  }
  if (existing) grants.delete(existing);
  const token = randomUUID().replace(/-/g, '');
  grants.set(token, { scope: { ...scope }, live });
  ownerTokens.set(owner, token);
  return `${HTML_DOC_SCHEME}://${token}/`;
}

export function revokeHtmlPreview(owner: object): void {
  const token = ownerTokens.get(owner);
  if (token) grants.delete(token);
  ownerTokens.delete(owner);
}

export function rootForPreviewToken(token: string): string | null {
  const grant = grants.get(token);
  if (!grant) return null;
  const live = grant.live();
  if (!live || live.root !== grant.scope.root || live.generation !== grant.scope.generation) {
    return null;
  }
  return grant.scope.root;
}

// ──────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested)
// ──────────────────────────────────────────────────────────────────

/** Map a URL pathname onto a file inside root; null when it escapes. */
export function resolvePreviewPath(root: string, pathname: string): string | null {
  let segments: string[];
  try {
    segments = pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (segments.length === 0) return null;
  if (segments.some((s) => s.includes('\0') || s.includes('/') || s.includes('\\'))) return null;
  const abs = resolve(root, ...segments);
  return isInside(root, abs) ? abs : null;
}

function isInside(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * CSP for every preview response. Local files and data/blob URLs are always
 * allowed; remote origins only when the user enabled network access. Script
 * execution is also gated by the iframe sandbox — this is defense in depth.
 */
export function buildPreviewCsp(policy: HtmlPreviewPolicy): string {
  const local = `${HTML_DOC_SCHEME}: data: blob:`;
  const remote = policy.network ? ' https: http:' : '';
  return [
    "default-src 'none'",
    `img-src ${local}${remote}`,
    `media-src ${local}${remote}`,
    `font-src ${local}${remote}`,
    `style-src ${HTML_DOC_SCHEME}: 'unsafe-inline'${remote}`,
    policy.scripts
      ? `script-src ${HTML_DOC_SCHEME}: blob: 'unsafe-inline' 'unsafe-eval'${remote}`
      : "script-src 'none'",
    `worker-src ${policy.scripts ? `${HTML_DOC_SCHEME}: blob:` : "'none'"}`,
    `connect-src ${policy.network ? 'https: http: wss: ws:' : "'none'"}`,
    `frame-src ${HTML_DOC_SCHEME}:${remote}`,
    "object-src 'none'",
    "form-action 'none'",
    `base-uri ${HTML_DOC_SCHEME}:`,
  ].join('; ');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

export function previewMimeType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

// ──────────────────────────────────────────────────────────────────
// Electron wiring
// ──────────────────────────────────────────────────────────────────

const MAX_PREVIEW_FILE_BYTES = 64 * 1024 * 1024;

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

async function servePreviewRequest(request: Request, policy: HtmlPreviewPolicy): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405 });
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return notFound();
  }
  const root = rootForPreviewToken(url.hostname);
  if (!root) return notFound();
  const abs = resolvePreviewPath(root, url.pathname);
  if (!abs) return notFound();
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(abs)]);
    if (!isInside(realRoot, realFile)) return notFound();
    const stat = await fs.stat(realFile);
    if (!stat.isFile() || stat.size > MAX_PREVIEW_FILE_BYTES) return notFound();
    const body = request.method === 'HEAD' ? null : await fs.readFile(realFile);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': previewMimeType(realFile),
        'content-security-policy': buildPreviewCsp(policy),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    });
  } catch {
    return notFound();
  }
}

function isPreviewUrl(url: string | undefined): boolean {
  return !!url && url.startsWith(`${HTML_DOC_SCHEME}:`);
}

/** Install the protocol handler and deny every permission to preview frames
 *  (camera, notifications, openExternal, …). Call once after `ready`. */
export function installHtmlDocProtocol(policy: () => HtmlPreviewPolicy): void {
  const ses = session.defaultSession;
  ses.protocol.handle(HTML_DOC_SCHEME, (request) => servePreviewRequest(request, policy()));

  // Iris itself never asks for permissions from a subframe; the preview is
  // the only embedded content, so subframes are denied wholesale.
  ses.setPermissionRequestHandler((_webContents, _permission, callback, details) => {
    callback(details.isMainFrame && !isPreviewUrl(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_webContents, _permission, _origin, details) =>
    details.isMainFrame && !isPreviewUrl(details.requestingUrl),
  );
}

const EXTERNAL_OPEN_INTERVAL_MS = 1000;

/**
 * Preview links: in-frame navigation between project files is allowed;
 * http(s)/mailto targets open in the system browser (throttled, so a script
 * cannot spam it); anything else is dropped. The main frame keeps its own
 * will-navigate guard.
 */
export function guardPreviewNavigation(webContents: WebContents): void {
  let lastExternalOpen = 0;
  webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    const target = details.url;
    if (isPreviewUrl(target) || target === 'about:blank' || target === 'about:srcdoc') return;
    details.preventDefault();
    if (!/^(?:https?|mailto):/i.test(target)) return;
    const now = Date.now();
    if (now - lastExternalOpen < EXTERNAL_OPEN_INTERVAL_MS) return;
    lastExternalOpen = now;
    void shell.openExternal(target).catch((err) => logger.warn('html-preview', 'openExternal failed', err));
  });
}
