/**
 * @file src/shared/html-doc.ts
 * @purpose HTML documents: format detection and byte-preserving metadata
 *   surgery, shared by main and renderer (issue 2026-10-25-支持HTML).
 *
 * HTML docs carry Iris metadata in the head instead of YAML frontmatter, so
 * the file stays a valid, directly shareable web page:
 *
 *   <title>…</title>                            → `title`
 *   <meta name="iris:status" content="Active">  → `status` (and any iris:<key>)
 *
 * Same zero-diff discipline as markdown-utils: never parse → re-serialize a
 * DOM. Reads and writes locate one element by offset and splice only that
 * span; every other byte (formatting, comments, scripts, CRLF) survives.
 * Comments and raw-text elements (script/style/…) are masked before
 * searching so a `<title>` inside a script string or comment never matches.
 */

export type DocFormat = 'markdown' | 'html';

/** Privileged scheme serving project files to the sandboxed HTML preview. */
export const HTML_DOC_SCHEME = 'iris-doc';

const HTML_EXT_RE = /\.html?$/i;
const DOC_EXT_RE = /\.(?:md|html?)$/i;

export function docFormatOf(path: string): DocFormat {
  return HTML_EXT_RE.test(path) ? 'html' : 'markdown';
}

/** File names the scanner projects as Iris documents. */
export function isIrisDocFileName(name: string): boolean {
  return DOC_EXT_RE.test(name);
}

/** Display fallback when a document has no title. */
export function stripDocExtension(name: string): string {
  return name.replace(DOC_EXT_RE, '');
}

const META_PREFIX = 'iris:';

// ──────────────────────────────────────────────────────────────────
// Scanning helpers
// ──────────────────────────────────────────────────────────────────

const INERT_RE =
  /<!--[\s\S]*?(?:-->|$)|(<(script|style|template|textarea|noscript|xmp)\b[^>]*>)([\s\S]*?)(?=<\/\2\s*>|$)/gi;

const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

/** Same-length copy with comments and raw-text element CONTENT blanked out
 *  (their opening tags stay visible, e.g. `<script src>`), so offsets found in
 *  the mask index straight into the original text. */
function maskInert(html: string): string {
  return html.replace(INERT_RE, (m, open?: string, _tag?: string, content?: string) =>
    open === undefined ? blank(m) : open + blank(content ?? ''),
  );
}

/** End offset of the head region, or -1 when the text has no head at all
 *  (an HTML fragment) — fragments carry no metadata. */
function headEnd(masked: string): number {
  const close = /<\/head\s*>/i.exec(masked);
  if (close) return close.index;
  const body = /<body[\s>]/i.exec(masked);
  return body ? body.index : -1;
}

interface Span {
  start: number;
  end: number;
}

function findTitle(html: string, masked: string): { inner: Span } | null {
  const limit = headEnd(masked);
  if (limit < 0) return null;
  const re = /<title\b[^>]*>/gi;
  const open = re.exec(masked);
  if (!open || open.index >= limit) return null;
  const innerStart = open.index + open[0].length;
  const close = /<\/title\s*>/i.exec(html.slice(innerStart));
  if (!close) return null;
  return { inner: { start: innerStart, end: innerStart + close.index } };
}

interface MetaTag {
  tag: Span;
  /** The raw value token of `content=` including quotes, or null when absent. */
  contentToken: Span | null;
  contentValue: string | null;
  name: string | null;
}

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseMetaTag(html: string, start: number, end: number): MetaTag {
  const text = html.slice(start, end);
  // Skip the "<meta" token; attributes follow.
  const attrsOffset = 5;
  const attrs = text.slice(attrsOffset);
  let name: string | null = null;
  let contentToken: Span | null = null;
  let contentValue: string | null = null;
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(attrs); m; m = ATTR_RE.exec(attrs)) {
    const attr = (m[1] ?? '').toLowerCase();
    const value = m[2] ?? m[3] ?? m[4];
    if (attr === 'name' && value !== undefined && name === null) name = decodeHtmlEntities(value);
    if (attr === 'content' && value !== undefined && contentToken === null) {
      const quoted = m[2] !== undefined || m[3] !== undefined;
      const tokenLength = value.length + (quoted ? 2 : 0);
      const tokenEnd = start + attrsOffset + m.index + m[0].length;
      contentToken = { start: tokenEnd - tokenLength, end: tokenEnd };
      contentValue = decodeHtmlEntities(value);
    }
  }
  return { tag: { start, end }, contentToken, contentValue, name };
}

function findMeta(html: string, masked: string, key: string): MetaTag | null {
  const limit = headEnd(masked);
  if (limit < 0) return null;
  const wanted = `${META_PREFIX}${key}`.toLowerCase();
  const re = /<meta\b[^>]*>/gi;
  for (let m = re.exec(masked); m && m.index < limit; m = re.exec(masked)) {
    const meta = parseMetaTag(html, m.index, m.index + m[0].length);
    if (meta.name?.trim().toLowerCase() === wanted) return meta;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Entities
// ──────────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

// ──────────────────────────────────────────────────────────────────
// Public metadata API
// ──────────────────────────────────────────────────────────────────

/** Read one Iris field: `title` from <title>, others from iris:<key> meta. */
export function getHtmlDocField(html: string, key: string): string | null {
  const masked = maskInert(html);
  if (key === 'title') {
    const title = findTitle(html, masked);
    if (!title) return null;
    return decodeHtmlEntities(html.slice(title.inner.start, title.inner.end))
      .replace(/\s+/g, ' ')
      .trim();
  }
  return findMeta(html, masked, key)?.contentValue ?? null;
}

/** Frontmatter-shaped projection of the head metadata (null when none). */
export function readHtmlDocMetadata(html: string): Record<string, string> | null {
  const masked = maskInert(html);
  const out: Record<string, string> = {};
  const title = getHtmlDocField(html, 'title');
  if (title !== null) out['title'] = title;
  const limit = headEnd(masked);
  if (limit >= 0) {
    const re = /<meta\b[^>]*>/gi;
    for (let m = re.exec(masked); m && m.index < limit; m = re.exec(masked)) {
      const meta = parseMetaTag(html, m.index, m.index + m[0].length);
      const name = meta.name?.trim() ?? '';
      if (!name.toLowerCase().startsWith(META_PREFIX) || meta.contentValue === null) continue;
      const key = name.slice(META_PREFIX.length);
      if (key && !(key in out)) out[key] = meta.contentValue;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Set (replace or insert) one Iris field with a single splice. Existing
 * elements keep their position, attributes and quoting neighbours; a missing
 * element is inserted just before </head> (creating a head when needed).
 */
export function setHtmlDocField(html: string, key: string, value: string): string {
  const masked = maskInert(html);
  if (key === 'title') {
    const title = findTitle(html, masked);
    if (title) return splice(html, title.inner, escapeText(value));
    return insertHeadChild(html, masked, `<title>${escapeText(value)}</title>`);
  }
  const meta = findMeta(html, masked, key);
  const quoted = `"${escapeAttr(value)}"`;
  if (meta?.contentToken) return splice(html, meta.contentToken, quoted);
  if (meta) {
    const tagText = html.slice(meta.tag.start, meta.tag.end);
    const close = /\s*\/?>$/.exec(tagText);
    const at = meta.tag.start + (close ? close.index : tagText.length - 1);
    return `${html.slice(0, at)} content=${quoted}${html.slice(at)}`;
  }
  return insertHeadChild(
    html,
    masked,
    `<meta name="${META_PREFIX}${escapeAttr(key)}" content=${quoted}>`,
  );
}

function splice(text: string, span: Span, replacement: string): string {
  return text.slice(0, span.start) + replacement + text.slice(span.end);
}

function lineStartOf(text: string, index: number): number {
  return text.lastIndexOf('\n', index - 1) + 1;
}

function insertHeadChild(html: string, masked: string, element: string): string {
  const eol = html.includes('\r\n') ? '\r\n' : '\n';

  const headClose = /<\/head\s*>/i.exec(masked);
  if (headClose) {
    const lineStart = lineStartOf(html, headClose.index);
    const before = html.slice(lineStart, headClose.index);
    if (before.trim() === '') {
      const insertion = `${before}  ${element}${eol}`;
      return html.slice(0, lineStart) + insertion + html.slice(lineStart);
    }
    return html.slice(0, headClose.index) + element + html.slice(headClose.index);
  }

  const head = (indent: string): string =>
    `${indent}<head>${eol}${indent}  ${element}${eol}${indent}</head>${eol}`;

  const body = /<body[\s>]/i.exec(masked);
  if (body) {
    const lineStart = lineStartOf(html, body.index);
    const before = html.slice(lineStart, body.index);
    if (before.trim() === '') {
      return html.slice(0, lineStart) + head(before) + html.slice(lineStart);
    }
    return `${html.slice(0, body.index)}<head>${element}</head>${html.slice(body.index)}`;
  }

  const opener = /<html\b[^>]*>/i.exec(masked) ?? /<!doctype\b[^>]*>/i.exec(masked);
  if (opener) {
    const at = opener.index + opener[0].length;
    return `${html.slice(0, at)}${eol}${head('').slice(0, -eol.length)}${html.slice(at)}`;
  }
  return head('') + html;
}

// ──────────────────────────────────────────────────────────────────
// References and skeleton
// ──────────────────────────────────────────────────────────────────

export interface HtmlReference {
  source: string;
  kind: 'image' | 'attachment';
}

const REFERENCE_ATTRS = new Set(['src', 'href', 'poster', 'data']);

/** Relative-looking resource references (src/href/poster/data attributes),
 *  for companion-asset reference counting. Inert regions are ignored. */
export function extractHtmlReferences(html: string): HtmlReference[] {
  const masked = maskInert(html);
  const out: HtmlReference[] = [];
  const tagRe = /<([a-z][\w-]*)\b[^>]*>/gi;
  for (let m = tagRe.exec(masked); m; m = tagRe.exec(masked)) {
    const tag = (m[1] ?? '').toLowerCase();
    const attrs = html.slice(m.index + 1 + tag.length, m.index + m[0].length);
    ATTR_RE.lastIndex = 0;
    for (let a = ATTR_RE.exec(attrs); a; a = ATTR_RE.exec(attrs)) {
      const attr = (a[1] ?? '').toLowerCase();
      const value = a[2] ?? a[3] ?? a[4];
      if (!REFERENCE_ATTRS.has(attr) || !value) continue;
      out.push({
        source: decodeHtmlEntities(value),
        kind: tag === 'img' || (tag === 'source' && attr === 'src') ? 'image' : 'attachment',
      });
    }
  }
  return out;
}

/** HTML snippet for an asset (the HTML counterpart of a Markdown link). */
export function htmlForAsset(asset: { name: string; kind: string; markdownUrl: string }): string {
  const label = escapeText(asset.name.replace(/\.[^.]+$/, ''));
  const url = escapeAttr(asset.markdownUrl);
  return asset.kind === 'image'
    ? `<img src="${url}" alt="${escapeAttr(asset.name.replace(/\.[^.]+$/, ''))}">`
    : `<a href="${url}">${label}</a>`;
}

/** New HTML document: a complete, standalone page with Iris metadata. */
export function htmlDocSkeleton(title: string, status: string, lang = 'en'): string {
  return [
    '<!doctype html>',
    `<html lang="${escapeAttr(lang)}">`,
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeText(title)}</title>`,
    `  <meta name="${META_PREFIX}status" content="${escapeAttr(status)}">`,
    '</head>',
    '<body>',
    `  <h1>${escapeText(title)}</h1>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
