import { describe, expect, it } from 'vitest';
import type { DocContent } from '@shared/types';
import {
  composeEditorDocument,
  advanceBaselineAfterSave,
  createEditorDocument,
  decideEditorSave,
  hydrateWysiwygBody,
  isEditorDocumentDirty,
  toggleEditorMode,
  updateFrontmatterBlock,
  updateSourceText,
  updateWysiwygBody,
} from './editor-session';

const content = (raw: string): DocContent => ({
  path: '.iris/issue/test.md',
  raw,
  body: raw,
  frontmatter: null,
  frontmatterBroken: false,
});

describe('editor document state', () => {
  it('treats WYSIWYG normalization during hydration as byte-clean', () => {
    const raw = '---\r\ntitle: x\r\n---\r\nbody  \r\n';
    const opened = createEditorDocument(content(raw));
    const hydrated = hydrateWysiwygBody(opened, 'body\n');

    expect(isEditorDocumentDirty(hydrated)).toBe(false);
    expect(composeEditorDocument(hydrated)).toBe(raw);
  });

  it('becomes dirty only for a post-hydration body change and cleans on revert', () => {
    const hydrated = hydrateWysiwygBody(createEditorDocument(content('old\n')), 'old\n');
    const changed = updateWysiwygBody(hydrated, 'new\n');
    const reverted = updateWysiwygBody(changed, 'old\n');

    expect(isEditorDocumentDirty(changed)).toBe(true);
    expect(composeEditorDocument(changed)).toBe('new\n');
    expect(isEditorDocumentDirty(reverted)).toBe(false);
    expect(composeEditorDocument(reverted)).toBe('old\n');
  });

  it('round-trips source mode without manufacturing a diff', () => {
    const hydrated = hydrateWysiwygBody(createEditorDocument(content('old  \n')), 'old\n');
    const source = toggleEditorMode(hydrated);
    const wysiwyg = toggleEditorMode(source);

    expect(source.sourceText).toBe('old  \n');
    expect(isEditorDocumentDirty(wysiwyg)).toBe(false);
    expect(composeEditorDocument(wysiwyg)).toBe('old  \n');
  });

  it('derives dirty from the complete composed bytes in source and frontmatter edits', () => {
    const opened = createEditorDocument(content('---\ntitle: old\n---\nbody\n'));
    const fmChanged = updateFrontmatterBlock(opened, '---\ntitle: new\n---\n');
    const source = toggleEditorMode(fmChanged);
    const reverted = updateSourceText(source, opened.baselineRaw);

    expect(isEditorDocumentDirty(fmChanged)).toBe(true);
    expect(isEditorDocumentDirty(reverted)).toBe(false);
  });

  it('blocks a conflicted save in ask mode and permits an explicit overwrite policy', () => {
    const hydrated = hydrateWysiwygBody(createEditorDocument(content('old\n')), 'old\n');
    const changed = updateWysiwygBody(hydrated, 'local\n');
    const external = content('external\n');

    expect(decideEditorSave(changed, external, 'ask')).toEqual({
      kind: 'blocked',
      reason: 'external-conflict',
    });
    expect(decideEditorSave(changed, external, 'overwrite')).toEqual({
      kind: 'write',
      content: 'local\n',
    });
  });

  it('advances a completed write baseline without discarding a later edit', () => {
    const hydrated = hydrateWysiwygBody(createEditorDocument(content('old\n')), 'old\n');
    const first = updateWysiwygBody(hydrated, 'first\n');
    const later = updateWysiwygBody(first, 'second\n');
    const advanced = advanceBaselineAfterSave(later, 'first\n', 'first\n', first.revision);

    expect(advanced.baselineRaw).toBe('first\n');
    expect(composeEditorDocument(advanced)).toBe('second\n');
    expect(isEditorDocumentDirty(advanced)).toBe(true);
  });
});
