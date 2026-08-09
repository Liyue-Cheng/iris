/**
 * Pure prompt-block parsing and replacement. Entry-file text outside Iris's
 * tagged blocks is always preserved verbatim.
 */
import type { DocType } from '@shared/types';
import { ISSUE_STATUS, REPORT_STATUS } from '@shared/document-status';
import { yamlScalar } from '@shared/markdown-utils';
import {
  PROJECT_BLOCK_TAG,
  SOFTWARE_BLOCK_TAG,
  SOFTWARE_PROMPT_TEMPLATE,
} from './iris-templates';

export function normalizePromptBody(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

export interface ParsedPromptBlock {
  body: string;
  hasAttributes: boolean;
  range: [number, number];
}

export class DuplicatePromptBlockError extends Error {
  constructor(public readonly tag: string) {
    super(`Multiple <${tag}> blocks are not supported`);
    this.name = 'DuplicatePromptBlockError';
  }
}

function parseTaggedBlocks(text: string, tag: string): ParsedPromptBlock[] {
  const matches = text.matchAll(
    new RegExp(`^(<${tag}\\b[^>]*>)\\r?\\n([\\s\\S]*?)^</${tag}>\\r?\\n?`, 'gm'),
  );
  return [...matches].map((match) => ({
    body: normalizePromptBody(match[2] ?? ''),
    hasAttributes: match[1] !== `<${tag}>`,
    range: [match.index, (match.index ?? 0) + match[0].length],
  }));
}

function parseTaggedBlock(text: string, tag: string): ParsedPromptBlock | null {
  return parseTaggedBlocks(text, tag)[0] ?? null;
}

export function parseSoftwareBlock(text: string): ParsedPromptBlock | null {
  return parseTaggedBlock(text, SOFTWARE_BLOCK_TAG);
}

export function parseSoftwareBlocks(text: string): ParsedPromptBlock[] {
  return parseTaggedBlocks(text, SOFTWARE_BLOCK_TAG);
}

export function parseProjectBlock(text: string): ParsedPromptBlock | null {
  return parseTaggedBlock(text, PROJECT_BLOCK_TAG);
}

export function parseProjectBlocks(text: string): ParsedPromptBlock[] {
  return parseTaggedBlocks(text, PROJECT_BLOCK_TAG);
}

export function buildSoftwareBlock(): string {
  return `<${SOFTWARE_BLOCK_TAG}>\n${SOFTWARE_PROMPT_TEMPLATE}\n</${SOFTWARE_BLOCK_TAG}>\n`;
}

export type SoftwareBlockState = 'ok' | 'drifted' | 'missing' | 'duplicate';

export function classifySoftwareBlock(text: string): { state: SoftwareBlockState } {
  const blocks = parseSoftwareBlocks(text);
  if (blocks.length > 1) return { state: 'duplicate' };
  const block = blocks[0] ?? null;
  if (!block) return { state: 'missing' };
  return {
    state:
      !block.hasAttributes && block.body === normalizePromptBody(SOFTWARE_PROMPT_TEMPLATE)
        ? 'ok'
        : 'drifted',
  };
}

export type UpsertAction = 'created' | 'updated' | 'removed' | 'unchanged';

function upsertTaggedBlock(
  text: string,
  tag: string,
  body: string | null,
): { text: string; action: UpsertAction } {
  const blocks = parseTaggedBlocks(text, tag);
  if (blocks.length > 1) throw new DuplicatePromptBlockError(tag);
  const existing = blocks[0] ?? null;
  const normalized = body === null ? '' : normalizePromptBody(body);

  if (normalized === '') {
    if (!existing) return { text, action: 'unchanged' };
    let [start, end] = existing.range;
    if (start > 0 && text.slice(0, start).endsWith('\n\n')) start -= 1;
    return { text: text.slice(0, start) + text.slice(end), action: 'removed' };
  }

  const block = `<${tag}>\n${normalized}\n</${tag}>\n`;
  if (!existing) {
    if (text.trim() === '') return { text: block, action: 'created' };
    const separator = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return { text: `${text}${separator}${block}`, action: 'created' };
  }
  if (existing.body === normalized && !existing.hasAttributes) {
    return { text, action: 'unchanged' };
  }
  const [start, end] = existing.range;
  return { text: text.slice(0, start) + block + text.slice(end), action: 'updated' };
}

export function upsertSoftwareBlock(
  text: string,
): { text: string; action: Exclude<UpsertAction, 'removed'> } {
  const result = upsertTaggedBlock(text, SOFTWARE_BLOCK_TAG, SOFTWARE_PROMPT_TEMPLATE);
  if (result.action === 'removed') return { text: result.text, action: 'updated' };
  return { text: result.text, action: result.action };
}

export function removeSoftwareBlock(text: string): { text: string; action: UpsertAction } {
  return upsertTaggedBlock(text, SOFTWARE_BLOCK_TAG, null);
}

export function upsertProjectBlock(
  text: string,
  body: string | null,
): { text: string; action: UpsertAction } {
  return upsertTaggedBlock(text, PROJECT_BLOCK_TAG, body);
}

export function docSkeleton(type: DocType, title: string): string {
  const lines = [`title: ${yamlScalar(title)}`];
  if (type === 'issue') lines.push(`status: ${ISSUE_STATUS.todo}`);
  if (type === 'report') lines.push(`status: ${REPORT_STATUS.active}`);
  if (type === 'status') lines.push('reflects:');
  return `---\n${lines.join('\n')}\n---\n`;
}
