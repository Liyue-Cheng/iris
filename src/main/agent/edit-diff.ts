import type { AgentTextEdit } from '@shared/agent-protocol';

export type TextEdit = AgentTextEdit;

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function applyTextEdits(content: string, edits: TextEdit[], path: string): string {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error(`Edit tool input is invalid for ${path}: edits must contain at least one replacement.`);
  }
  const hasBom = content.charCodeAt(0) === 0xfeff;
  const normalizedContent = normalizeToLF(hasBom ? content.slice(1) : content);
  const normalized = edits.map((edit, index) => {
    if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
      throw new Error(`edits[${index}] is invalid for ${path}.`);
    }
    const oldText = normalizeToLF(edit.oldText);
    const newText = normalizeToLF(edit.newText);
    if (!oldText) throw new Error(`edits[${index}].oldText must not be empty in ${path}.`);
    if (/^\*\*\* (?:Begin|Update|End) Patch\b/mu.test(newText) || /^@@/mu.test(newText)) {
      throw new Error(`edits[${index}].newText looks like a unified patch in ${path}; use oldText/newText replacements instead.`);
    }
    return { oldText, newText, index };
  });
  const matches = normalized.map((edit) => {
    const first = normalizedContent.indexOf(edit.oldText);
    if (first < 0) throw new Error(`Could not find edits[${edit.index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`);
    const second = normalizedContent.indexOf(edit.oldText, first + edit.oldText.length);
    if (second >= 0) throw new Error(`Found multiple occurrences of edits[${edit.index}] in ${path}. Each oldText must be unique.`);
    return { ...edit, start: first, end: first + edit.oldText.length };
  }).sort((a, b) => a.start - b.start);
  for (let index = 1; index < matches.length; index += 1) {
    if (matches[index - 1]!.end > matches[index]!.start) {
      throw new Error(`edits[${matches[index - 1]!.index}] and edits[${matches[index]!.index}] overlap in ${path}.`);
    }
  }
  let result = normalizedContent;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const edit = matches[index]!;
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  if (result === normalizedContent) throw new Error(`No changes made to ${path}.`);
  const restored = content.includes('\r\n') ? result.replace(/\n/g, '\r\n') : result;
  return hasBom ? `\ufeff${restored}` : restored;
}
