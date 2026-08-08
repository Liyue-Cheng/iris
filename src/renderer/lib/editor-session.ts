import type { DocContent, EditorConflictPolicy } from '@shared/types';
import { splitFrontmatter } from '@shared/markdown-utils';

export type EditorMode = 'wysiwyg' | 'source';

/** Pure document state. Runtime concerns such as timers, IPC and Crepe live
 * outside this structure so dirty remains a deterministic byte comparison. */
export interface EditorDocumentState {
  path: string;
  baselineRaw: string;
  fmBlock: string;
  originalBody: string;
  bodyBaseline: string | null;
  bodyCurrent: string | null;
  mode: EditorMode;
  sourceText: string;
  revision: number;
}

export type SaveDecision =
  | { kind: 'noop' }
  | { kind: 'blocked'; reason: 'external-conflict' }
  | { kind: 'write'; content: string };

export function createEditorDocument(content: DocContent): EditorDocumentState {
  const { fmBlock, body } = splitFrontmatter(content.raw);
  return {
    path: content.path,
    baselineRaw: content.raw,
    fmBlock,
    originalBody: body,
    bodyBaseline: null,
    bodyCurrent: null,
    mode: 'wysiwyg',
    sourceText: content.raw,
    revision: 0,
  };
}

function composedBody(state: EditorDocumentState): string {
  const changed =
    state.bodyBaseline !== null &&
    state.bodyCurrent !== null &&
    state.bodyCurrent !== state.bodyBaseline;
  return changed ? (state.bodyCurrent ?? state.originalBody) : state.originalBody;
}

export function composeEditorDocument(state: EditorDocumentState): string {
  return state.mode === 'source' ? state.sourceText : state.fmBlock + composedBody(state);
}

export function isEditorDocumentDirty(state: EditorDocumentState): boolean {
  return composeEditorDocument(state) !== state.baselineRaw;
}

/** Establish the serialization-equivalence baseline after Crepe has settled.
 * The original body bytes remain authoritative until a later user update. */
export function hydrateWysiwygBody(
  state: EditorDocumentState,
  markdown: string,
): EditorDocumentState {
  if (state.mode !== 'wysiwyg') return state;
  return { ...state, bodyBaseline: markdown, bodyCurrent: markdown };
}

export function updateWysiwygBody(
  state: EditorDocumentState,
  markdown: string,
): EditorDocumentState {
  if (state.mode !== 'wysiwyg' || state.bodyBaseline === null) return state;
  if (state.bodyCurrent === markdown) return state;
  return { ...state, bodyCurrent: markdown, revision: state.revision + 1 };
}

export function updateSourceText(
  state: EditorDocumentState,
  text: string,
): EditorDocumentState {
  if (state.mode !== 'source' || state.sourceText === text) return state;
  return { ...state, sourceText: text, revision: state.revision + 1 };
}

export function updateFrontmatterBlock(
  state: EditorDocumentState,
  fmBlock: string,
): EditorDocumentState {
  if (state.fmBlock === fmBlock) return state;
  return { ...state, fmBlock, revision: state.revision + 1 };
}

export function toggleEditorMode(state: EditorDocumentState): EditorDocumentState {
  if (state.mode === 'wysiwyg') {
    return { ...state, mode: 'source', sourceText: composeEditorDocument(state) };
  }

  const { fmBlock, body } = splitFrontmatter(state.sourceText);
  return {
    ...state,
    mode: 'wysiwyg',
    fmBlock,
    originalBody: body,
    bodyBaseline: null,
    bodyCurrent: null,
  };
}

/** Rebase only the exact revision that was persisted. Later edits keep their
 * old baseline until their own queued snapshot succeeds. */
export function rebaseAfterSave(
  state: EditorDocumentState,
  content: string,
  savedBodySerialization: string | null,
): EditorDocumentState {
  const { fmBlock, body } = splitFrontmatter(content);
  if (state.mode === 'source') {
    return {
      ...state,
      baselineRaw: content,
      fmBlock,
      originalBody: body,
      sourceText: content,
    };
  }
  return {
    ...state,
    baselineRaw: content,
    fmBlock,
    originalBody: body,
    bodyBaseline: savedBodySerialization,
    bodyCurrent: savedBodySerialization,
    sourceText: content,
  };
}

/** Advance the disk baseline after an older revision succeeds without
 * discarding edits made while that write was in flight. */
export function advanceBaselineAfterSave(
  state: EditorDocumentState,
  content: string,
  savedBodySerialization: string | null,
  savedRevision: number,
): EditorDocumentState {
  if (state.revision === savedRevision) {
    return rebaseAfterSave(state, content, savedBodySerialization);
  }
  if (state.mode === 'source') return { ...state, baselineRaw: content };
  const { body } = splitFrontmatter(content);
  return {
    ...state,
    baselineRaw: content,
    originalBody: body,
    bodyBaseline: savedBodySerialization,
  };
}

export function decideEditorSave(
  state: EditorDocumentState,
  conflict: DocContent | null,
  policy: EditorConflictPolicy,
  forceOverwrite = false,
): SaveDecision {
  const content = composeEditorDocument(state);
  if (content === state.baselineRaw) return { kind: 'noop' };
  if (conflict && policy === 'ask' && !forceOverwrite) {
    return { kind: 'blocked', reason: 'external-conflict' };
  }
  return { kind: 'write', content };
}
