/**
 * @file src/shared/markdown-utils.ts
 * @purpose Byte-preserving frontmatter surgery, shared by main and renderer.
 *
 * The zero-diff discipline (roadmap M2): bytes the user didn't edit must
 * survive a save unchanged. So frontmatter is edited SURGICALLY — the block
 * is kept as a literal string and single key lines are replaced/inserted;
 * everything else (unknown keys, comments, quoting style, even broken YAML)
 * passes through verbatim. No parse → re-stringify roundtrips here.
 */

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

/**
 * Set (replace or insert) one top-level key in a frontmatter block.
 * - Empty block → a fresh `---\nkey: value\n---\n` block is created.
 * - Existing key line → that line alone is rewritten.
 * - Missing key → inserted before the closing fence.
 * Only top-level `key:` lines (no leading whitespace) are matched; nested
 * mappings are untouched.
 */
export function setFrontmatterKey(fmBlock: string, key: string, value: string): string {
  const line = `${key}: ${yamlScalar(value)}`;
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
