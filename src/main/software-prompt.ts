/**
 * @file src/main/software-prompt.ts
 * @purpose The deterministic core of prompt governance (issue: iris软件提示词
 *   治理). Pure functions — no electron, no fs — so they unit-test cleanly and
 *   stay inside the "渲染层确定性" red line (tag parse + hash compare, never a
 *   heuristic or an LLM).
 *
 *   Two governed artifacts:
 *   - The `<iris-software>` managed block embedded in project-root entry files
 *     (AGENTS.md, and any existing vendor entry). Content-keyed by a short sha
 *     so a hand-edit is detectable; version attr is informational.
 *   - The project constitution (`.iris/CONVENTIONS.md`): classified against the
 *     set of shipped factory defaults so an UNTOUCHED default can be offered an
 *     upgrade while a customized one is left alone.
 *
 *   The IO (scanning files, writing after confirmation) lives in
 *   agent-injection.ts / project-manager.ts; the prose lives in
 *   iris-templates.ts. This module is the logic between them.
 */
import { createHash } from 'node:crypto';
import type { DocType } from '@shared/types';
import { yamlScalar } from '@shared/markdown-utils';
import {
  CONSTITUTION_TEMPLATE,
  LEGACY_CONSTITUTION_DEFAULTS,
  PROTOCOL_VERSION,
  SOFTWARE_BLOCK_TAG,
  SOFTWARE_PROMPT_TEMPLATE,
} from './iris-templates';

// ──────────────────────────────────────────────────────────────────
// Hashing — one normalization, used for every content fingerprint so the
// build side and the parse side always agree (CRLF and trailing whitespace
// must not change identity: entry files cross editors and OSes).
// ──────────────────────────────────────────────────────────────────

export function normalizeForHash(s: string): string {
  // Trim BOTH ends: a managed block stores its body as `\n<body>\n`, and the
  // template has no surrounding whitespace — identity must ignore that framing
  // (and any CRLF an editor introduced). Our hashed texts (frontmatter docs,
  // prompt bodies) carry no significant leading whitespace.
  return s.replace(/\r\n/g, '\n').trim();
}

/** Short content fingerprint (sha256, 12 hex chars). */
export function contentHash(s: string): string {
  return createHash('sha256').update(normalizeForHash(s), 'utf8').digest('hex').slice(0, 12);
}

// ──────────────────────────────────────────────────────────────────
// Software-layer managed block
// ──────────────────────────────────────────────────────────────────

/** Fingerprint of the current shipped software-prompt body. */
export const SOFTWARE_PROMPT_SHA = contentHash(SOFTWARE_PROMPT_TEMPLATE);

/**
 * Fingerprints of PRIOR shipped software-prompt bodies. A block whose body
 * matches one of these (and whose declared sha is intact) is an older but
 * untouched factory block → `stale`, safe to re-sync. APPEND the outgoing
 * SOFTWARE_PROMPT_SHA here when SOFTWARE_PROMPT_TEMPLATE changes.
 */
export const HISTORICAL_SOFTWARE_PROMPT_SHAS: readonly string[] = [
  // protocol-1 body: report 还是 append-only、issue 无追加纪律、无 frontmatter
  // schema / todo 机制（"What the app parses" 一节是 protocol 2 加入的）。
  '787bcd6a3a44',
];

const BLOCK_RE = new RegExp(`<${SOFTWARE_BLOCK_TAG}\\b([^>]*)>([\\s\\S]*?)</${SOFTWARE_BLOCK_TAG}>\\n?`);

export interface ParsedBlock {
  /** Raw attribute string from the opening tag. */
  attrs: Record<string, string>;
  /** Body between the tags, normalized for hashing. */
  body: string;
  /** sha declared in the opening tag (may be absent → ''). */
  declaredSha: string;
  /** Recomputed sha over the actual body. */
  actualSha: string;
  version: string;
  /** [start, end) char range of the whole block in the source. */
  range: [number, number];
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) {
    const key = m[1];
    const val = m[2];
    if (key !== undefined && val !== undefined) out[key] = val;
  }
  return out;
}

/** Find the `<iris-software>` block in `text`, or null if absent. */
export function parseSoftwareBlock(text: string): ParsedBlock | null {
  const m = BLOCK_RE.exec(text);
  if (!m) return null;
  const attrs = parseAttrs(m[1] ?? '');
  const body = normalizeForHash(m[2] ?? '');
  return {
    attrs,
    body,
    declaredSha: attrs.sha ?? '',
    actualSha: contentHash(body),
    version: attrs.version ?? '',
    range: [m.index, m.index + m[0].length],
  };
}

/** Build the managed block for a given app version. sha keys the body only. */
export function buildSoftwareBlock(appVersion: string): string {
  const sha = SOFTWARE_PROMPT_SHA;
  return (
    `<${SOFTWARE_BLOCK_TAG} version="${appVersion}" protocol="${PROTOCOL_VERSION}" sha="${sha}">\n` +
    `${SOFTWARE_PROMPT_TEMPLATE}\n` +
    `</${SOFTWARE_BLOCK_TAG}>\n`
  );
}

export type SoftwareBlockState = 'ok' | 'stale' | 'drifted' | 'missing';

export interface SoftwareBlockStatus {
  state: SoftwareBlockState;
  /** version attr found in the block (informational). */
  version?: string;
}

/**
 * Classify an entry file's text. Content-keyed:
 * - missing  — no block at all.
 * - drifted  — body no longer matches its declared sha (hand-edited), OR the
 *              body is intact but is neither the current nor a known prior
 *              shipped version (foreign/unknown content).
 * - stale    — body is an intact PRIOR shipped version → safe re-sync.
 * - ok        — body is the current shipped version.
 */
export function classifySoftwareBlock(text: string): SoftwareBlockStatus {
  const block = parseSoftwareBlock(text);
  if (!block) return { state: 'missing' };
  const { actualSha, declaredSha, version } = block;
  // Declared sha present but body changed under it → a hand edit.
  if (declaredSha && declaredSha !== actualSha) return { state: 'drifted', version };
  if (actualSha === SOFTWARE_PROMPT_SHA) return { state: 'ok', version };
  if (HISTORICAL_SOFTWARE_PROMPT_SHAS.includes(actualSha)) return { state: 'stale', version };
  return { state: 'drifted', version };
}

export type UpsertAction = 'created' | 'updated' | 'unchanged';

/**
 * Insert or refresh the managed block, preserving everything outside it.
 * - no block            → append (with a blank-line separator if needed).
 * - block already current → unchanged (no needless rewrite / .bak churn).
 * - block present, stale/drifted/old-version → replace in place.
 */
export function upsertSoftwareBlock(
  text: string,
  appVersion: string,
): { text: string; action: UpsertAction } {
  const block = buildSoftwareBlock(appVersion);
  const existing = parseSoftwareBlock(text);

  if (!existing) {
    if (text.trim() === '') return { text: block, action: 'created' };
    const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return { text: `${text}${sep}${block}`, action: 'created' };
  }

  // Already the current body AND current version attr → leave it alone.
  if (existing.actualSha === SOFTWARE_PROMPT_SHA && existing.version === appVersion) {
    return { text, action: 'unchanged' };
  }
  const [start, end] = existing.range;
  return { text: text.slice(0, start) + block + text.slice(end), action: 'updated' };
}

// ──────────────────────────────────────────────────────────────────
// New-doc frontmatter skeleton — the single source both createDoc (UI leg)
// and the software prompt's example (agent leg) must agree on; the
// consistency is locked by test so the two cannot drift apart.
// ──────────────────────────────────────────────────────────────────

/**
 * Frontmatter skeleton for a newly created doc. `reflects:` is written as an
 * empty placeholder on status docs: stamping a sha at creation would be a lie
 * (an empty doc reflects nothing), but the mandatory key must be visible from
 * birth so whoever writes the first real content knows to stamp it.
 */
export function docSkeleton(type: DocType, title: string): string {
  const lines = [`title: ${yamlScalar(title)}`];
  // Stored value = displayed value (规约六态/两态, 批次2).
  if (type === 'issue') lines.push('status: Todo');
  if (type === 'report') lines.push('status: Active');
  if (type === 'status') lines.push('reflects:');
  return `---\n${lines.join('\n')}\n---\n`;
}

// ──────────────────────────────────────────────────────────────────
// Project-layer constitution: factory-default recognition (§5)
// ──────────────────────────────────────────────────────────────────

/** Fingerprint of the current shipped constitution default. */
export const CONSTITUTION_SHA = contentHash(CONSTITUTION_TEMPLATE);

/** Fingerprints of every prior shipped constitution default. */
export const LEGACY_CONSTITUTION_SHAS: readonly string[] = LEGACY_CONSTITUTION_DEFAULTS.map(
  contentHash,
);

export type ConstitutionState = 'current-default' | 'stale-default' | 'customized';

/**
 * Is the on-disk constitution still a factory default, and if so is it the
 * current one?
 * - current-default — matches the shipped template → up to date.
 * - stale-default   — matches a PRIOR shipped template → upgrade available.
 * - customized       — matches none → human-owned, never auto-upgrade.
 */
export function classifyConstitution(text: string): ConstitutionState {
  const sha = contentHash(text);
  if (sha === CONSTITUTION_SHA) return 'current-default';
  if (LEGACY_CONSTITUTION_SHAS.includes(sha)) return 'stale-default';
  return 'customized';
}
