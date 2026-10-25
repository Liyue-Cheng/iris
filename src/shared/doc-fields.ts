/**
 * @file src/shared/doc-fields.ts
 * @purpose Format-dispatched Iris field surgery: one entry point for callers
 *   that edit `title:` / `status:` without caring whether the document keeps
 *   them in YAML frontmatter (Markdown) or in the head (HTML).
 */
import { docFormatOf, getHtmlDocField, setHtmlDocField } from './html-doc';
import {
  checkAllTaskCheckboxes,
  getFrontmatterKey,
  setFrontmatterKey,
  splitFrontmatter,
} from './markdown-utils';

export function getDocField(path: string, raw: string, key: string): string | null {
  if (docFormatOf(path) === 'html') return getHtmlDocField(raw, key);
  return getFrontmatterKey(splitFrontmatter(raw).fmBlock, key);
}

/** Returns raw unchanged when the field cannot be written safely (a
 *  malformed frontmatter block is never guessed at). */
export function setDocField(path: string, raw: string, key: string, value: string): string {
  if (docFormatOf(path) === 'html') return setHtmlDocField(raw, key, value);
  const { fmBlock, body } = splitFrontmatter(raw);
  const nextFm = setFrontmatterKey(fmBlock, key, value);
  if (fmBlock !== '' && nextFm === fmBlock) return raw;
  return nextFm + body;
}

/** GFM task checkboxes exist only in Markdown documents. */
export function checkAllDocTaskCheckboxes(path: string, raw: string): string {
  return docFormatOf(path) === 'html' ? raw : checkAllTaskCheckboxes(raw);
}
