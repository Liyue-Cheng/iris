/**
 * @file src/shared/markdown-utils.ts
 * @purpose Byte-preserving frontmatter surgery, shared by main and renderer.
 *
 * The zero-diff discipline (roadmap M2): bytes the user didn't edit must
 * survive a save unchanged. So frontmatter is edited SURGICALLY — the block
 * is kept as a literal string and single key lines are replaced/inserted;
 * everything else (unknown keys, comments, quoting style, even broken YAML)
 * passes through verbatim. No parse → re-stringify roundtrips here.
 *
 * Also home of the GFM task-item line parse (extractTodos) — pure text
 * logic shared by the scanner (read side) and the panel surgery (write
 * side verification).
 */
import type { DocTodo } from './types';

export interface SplitDoc {
  /** The literal frontmatter block including both `---` fences and the
   *  trailing newline — or '' when the doc has none. raw === fmBlock + body. */
  fmBlock: string;
  body: string;
}

const FM_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function splitFrontmatter(raw: string): SplitDoc {
  const m = FM_RE.exec(raw);
  if (!m) return { fmBlock: '', body: raw };
  return { fmBlock: m[0], body: raw.slice(m[0].length) };
}

/** Minimal YAML scalar quoting: plain when safe, JSON-quoted otherwise. */
export function yamlScalar(value: string): string {
  if (value === '') return "''";
  const needsQuoting =
    /[:#\[\]{},&*!|>'"%@`]/.test(value) ||
    /^[\s-?]/.test(value) ||
    /\s$/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^[\d.+-]/.test(value);
  return needsQuoting ? JSON.stringify(value) : value;
}

/** Single-line YAML flow sequence, items quoted minimally: `[bug, ui]`.
 *  Single-line so setFrontmatterRawKey's line surgery stays applicable. */
export function yamlFlowSeq(items: string[]): string {
  return `[${items.map(yamlScalar).join(', ')}]`;
}

/**
 * Set (replace or insert) one top-level key in a frontmatter block.
 * - Empty block → a fresh `---\nkey: value\n---\n` block is created.
 * - Existing key line → that line alone is rewritten.
 * - Missing key → inserted before the closing fence.
 * Only top-level `key:` lines (no leading whitespace) are matched; nested
 * mappings are untouched.
 */
export function setFrontmatterKey(fmBlock: string, key: string, value: string): string {
  return setFrontmatterRawKey(fmBlock, key, yamlScalar(value));
}

/**
 * Same surgery, but the value is a preformatted single-line YAML literal
 * (e.g. a flow sequence from yamlFlowSeq) written without extra quoting.
 * The value must not contain newlines — that would break the line surgery.
 */
export function setFrontmatterRawKey(fmBlock: string, key: string, rawValue: string): string {
  const line = `${key}: ${rawValue}`;
  if (fmBlock === '') {
    return `---\n${line}\n---\n`;
  }
  const lines = fmBlock.split(/\r?\n/);
  // locate closing fence (last line that is exactly ---)
  let closing = -1;
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i] === '---') {
      closing = i;
      break;
    }
  }
  if (closing <= 0) {
    // malformed block — leave it alone rather than guess
    return fmBlock;
  }
  const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  for (let i = 1; i < closing; i++) {
    if (keyRe.test(lines[i] ?? '')) {
      lines[i] = line;
      return lines.join('\n');
    }
  }
  lines.splice(closing, 0, line);
  return lines.join('\n');
}

/** Read one top-level scalar key from a frontmatter block (literal-ish). */
export function getFrontmatterKey(fmBlock: string, key: string): string | null {
  const keyRe = new RegExp(
    `^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.*)$`,
    'm',
  );
  const m = keyRe.exec(fmBlock);
  if (!m) return null;
  let v = (m[1] ?? '').trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    try {
      v = v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1).replace(/''/g, "'");
    } catch {
      /* keep raw */
    }
  }
  return v;
}

/**
 * Literal parse of a single-line flow-sequence value as read by
 * getFrontmatterKey: `[a, "b: c"]` → items. A lone scalar yields a
 * singleton (mirror of the scanner's labels projection); empty/blank → [].
 * Quote handling covers what yamlFlowSeq writes (JSON double quotes,
 * simple single quotes) — no full YAML here.
 */
export function parseYamlFlowSeq(value: string): string[] {
  const v = value.trim();
  if (v === '' || v === '[]') return [];
  if (!(v.startsWith('[') && v.endsWith(']'))) return [unquoteScalar(v)];
  const inner = v.slice(1, -1);
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      current += ch;
      if (ch === quote && !(quote === '"' && inner[i - 1] === '\\')) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map((s) => unquoteScalar(s.trim())).filter((s) => s !== '');
}

function unquoteScalar(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v;
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/** GFM task item: list marker (bullet or ordered), checkbox, non-empty text. */
const TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/;
/** Fence opener: up to 3 spaces of indent, then ``` or ~~~ (CommonMark). */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Extract GFM task-list items (`- [ ]` / `- [x]`) from a doc, literally:
 * a per-line parse with deterministic fenced-code tracking (a fence closes
 * only on a matching marker of equal-or-greater length, per CommonMark).
 * Frontmatter lines are skipped; indented (4-space) code blocks are NOT
 * tracked — that would need full block-level context. Empty-text items are
 * ignored (nothing to manage). Line numbers index into the FULL file text.
 */
export function extractTodos(raw: string): DocTodo[] {
  const { fmBlock, body } = splitFrontmatter(raw);
  const offset = (fmBlock.match(/\n/g) ?? []).length;
  const todos: DocTodo[] = [];
  let fence: { char: string; len: number } | null = null;

  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fm = FENCE_OPEN_RE.exec(line);
    if (fence) {
      if (fm && fm[1]![0] === fence.char && fm[1]!.length >= fence.len && /^\s*$/.test(line.slice(fm[0].length))) {
        fence = null;
      }
      continue;
    }
    if (fm) {
      fence = { char: fm[1]![0]!, len: fm[1]!.length };
      continue;
    }
    const m = TASK_RE.exec(line);
    if (!m || m[2]!.trim() === '') continue;
    todos.push({
      line: offset + i,
      checked: m[1] !== ' ',
      text: m[2]!.trim(),
      raw: line,
    });
  }
  return todos;
}

/** File-name slug: keep CJK and word chars, collapse the rest into dashes. */
export function slugify(input: string): string {
  return (
    input
      .trim()
      .replace(/[\\/:*?"<>|#%{}^~\[\]`]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'untitled'
  );
}
