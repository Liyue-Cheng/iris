/**
 * @file stores/editor-store.ts
 * @purpose The editing session of the open document. Owns the byte-level
 *   composition rules that make saves diff-quiet, and the echo dedup that
 *   keeps our own writes from re-projecting into the editor.
 *
 * Composition discipline (roadmap M2 zero-diff):
 * - The frontmatter block is a literal string, edited surgically
 *   (setFrontmatterKey) — unknown keys/quoting/comments survive verbatim.
 * - The body serializes through Crepe ONLY when the user actually changed
 *   it (current serialization !== the serialization captured at load).
 *   An untouched body saves as its ORIGINAL bytes, so WYSIWYG normalization
 *   alone never produces a diff.
 * - No edits at all → save is a no-op.
 *
 * Echo dedup (technical-design.md 中断系统): the editor state is the source
 * of truth and is updated BEFORE doc.save dispatches, so when the watcher
 * echoes our own write back, disk content === lastWritten → no information →
 * skip. Order of arrival doesn't matter; no registration step, no TTL.
 *
 * External-change policy: clean session → reload live; dirty session → keep
 * the user's work, raise a conflict flag (last writer wins on next save).
 *
 * Dependency rule: this module never imports project-store (no cycles);
 * interrupts.ts orchestrates both.
 */
import { useSyncExternalStore } from 'react';
import { CHANNELS } from '@shared/protocol';
import type { DocContent } from '@shared/types';
import {
  getFrontmatterKey,
  setFrontmatterKey,
  setFrontmatterRawKey,
  splitFrontmatter,
} from '@shared/markdown-utils';
import { pipeline } from '@renderer/cpu';

export type EditorMode = 'wysiwyg' | 'source';

export interface EditorSession {
  path: string;
  /** Literal frontmatter block (possibly ''), current edited form. */
  fmBlock: string;
  /** Body bytes as loaded (or as last saved). */
  originalBody: string;
  /** Crepe serialization captured right after load — the "unchanged" baseline. */
  bodyBaseline: string | null;
  /** Latest Crepe serialization. */
  bodyCurrent: string | null;
  fmChanged: boolean;
  mode: EditorMode;
  /** Full-file text while in source mode. */
  sourceText: string;
  /** Source text at source-mode entry — the "unchanged" baseline. */
  sourceBaseline: string;
  sourceChanged: boolean;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  /** An external write landed while the session was dirty. */
  externalConflict: boolean;
  /** Bumped when content must be force-reloaded into the editor component. */
  generation: number;
}

let session: EditorSession | null = null;
const subscribers = new Set<() => void>();

/** Exact bytes of our last write per path — the echo-dedup compare table. */
const lastWritten = new Map<string, string>();

/** One-shot: the next editor mount should grab input focus (new-doc create). */
let focusOnMount = false;

/** GFM task-list checkbox marker at a list-item start (`- [ ]` / `1. [x]`…). */
const TASK_CHECKBOX = /^(\s*(?:[-*+]|\d+\.)\s+)\[[ xX]\]/gm;

/** True when prev → next differs ONLY in checkbox state (a discrete toggle),
 *  not in any surrounding text — the signal to persist at once. */
function isPureCheckboxToggle(prev: string, next: string): boolean {
  if (prev === next) return false;
  const strip = (s: string): string => s.replace(TASK_CHECKBOX, '$1[ ]');
  return strip(prev) === strip(next);
}

function emit(): void {
  subscribers.forEach((cb) => cb());
}

function patch(p: Partial<EditorSession>): void {
  if (!session) return;
  session = { ...session, ...p };
  emit();
}

function computeDirty(s: EditorSession): boolean {
  if (s.mode === 'source') return s.sourceChanged || s.fmChanged;
  const bodyChanged =
    s.bodyBaseline !== null && s.bodyCurrent !== null && s.bodyCurrent !== s.bodyBaseline;
  return s.fmChanged || bodyChanged;
}

/** Compose the exact file bytes to write. */
/** Commit an edited frontmatter block and persist (no-op when unchanged). */
async function applyFmBlock(fmBlock: string): Promise<void> {
  if (!session || fmBlock === session.fmBlock) return;
  const next = { ...session, fmBlock, fmChanged: true };
  patch({ fmBlock, fmChanged: true, dirty: computeDirty(next) });
  await editorStore.save();
}

function compose(s: EditorSession): string {
  if (s.mode === 'source') return s.sourceText;
  const bodyChanged =
    s.bodyBaseline !== null && s.bodyCurrent !== null && s.bodyCurrent !== s.bodyBaseline;
  const body = bodyChanged ? (s.bodyCurrent ?? s.originalBody) : s.originalBody;
  return s.fmBlock + body;
}

export const editorStore = {
  get(): EditorSession | null {
    return session;
  },

  /** Open a fresh session from loaded content (doc switch / external reload). */
  openSession(content: DocContent, opts?: { focus?: boolean }): void {
    const { fmBlock, body } = splitFrontmatter(content.raw);
    session = {
      path: content.path,
      fmBlock,
      originalBody: body,
      bodyBaseline: null,
      bodyCurrent: null,
      fmChanged: false,
      mode: 'wysiwyg',
      sourceText: content.raw,
      sourceBaseline: content.raw,
      sourceChanged: false,
      dirty: false,
      saving: false,
      saveError: null,
      externalConflict: false,
      generation: (session?.path === content.path ? session.generation : 0) + 1,
    };
    // Seed the echo-dedup table with the just-loaded bytes. An immediate
    // watcher echo of identical content carries no information and must NOT
    // bounce the editor through a remount — notably the create-write of a
    // fresh doc, which never went through doc.save (so it had no lastWritten
    // entry) and otherwise re-opens the session ~one watcher tick after the
    // doc is selected. A genuine external change has different bytes and
    // still reloads via handleDiskChange.
    lastWritten.set(content.path, content.raw);
    if (opts?.focus) focusOnMount = true;
    emit();
  },

  /** Consumed once by the editor mount to decide whether to grab focus. */
  consumeFocusOnMount(): boolean {
    if (!focusOnMount) return false;
    focusOnMount = false;
    return true;
  },

  closeSession(): void {
    session = null;
    emit();
  },

  /** Crepe reports its serialization of the just-loaded doc. */
  setBodyBaseline(md: string): void {
    if (!session) return;
    patch({ bodyBaseline: md, bodyCurrent: md });
  },

  /** Crepe reports an updated serialization. */
  setBody(md: string): void {
    if (!session) return;
    const prev = session.bodyCurrent;
    const next = { ...session, bodyCurrent: md };
    patch({ bodyCurrent: md, dirty: computeDirty(next) });
    // A task-checkbox toggle is a discrete click that should persist at once
    // (parity with the todo panel's checkTodo) — unlike free typing, which
    // batches to blur/switch/Ctrl+S. Detect it deterministically: the only
    // delta from the previous serialization is GFM checkbox state.
    if (prev !== null && isPureCheckboxToggle(prev, md)) {
      void editorStore.save();
    }
  },

  setSourceText(text: string): void {
    if (!session) return;
    const sourceChanged = text !== session.sourceBaseline;
    const next = { ...session, sourceText: text, sourceChanged };
    patch({ sourceText: text, sourceChanged, dirty: computeDirty(next) });
  },

  /** Header field edit — surgical, then persists immediately. */
  async setFrontmatterField(key: string, value: string): Promise<void> {
    if (!session) return;
    await applyFmBlock(setFrontmatterKey(session.fmBlock, key, value));
  },

  /** Same, but the value is a preformatted single-line YAML literal
   *  (labels flow sequence) written without scalar quoting. */
  async setFrontmatterFieldRaw(key: string, rawValue: string): Promise<void> {
    if (!session) return;
    await applyFmBlock(setFrontmatterRawKey(session.fmBlock, key, rawValue));
  },

  getFrontmatterField(key: string): string | null {
    if (!session) return null;
    return getFrontmatterKey(session.fmBlock, key);
  },

  /** wysiwyg ↔ source with content handover. */
  toggleMode(): void {
    if (!session) return;
    if (session.mode === 'wysiwyg') {
      const text = compose(session);
      patch({ mode: 'source', sourceText: text, sourceBaseline: text, sourceChanged: false });
    } else {
      // Re-split the (possibly edited) source back into fm + body. Edits made
      // in source mode replace the byte baselines wholesale, so carry the
      // pending-change flag via fmChanged until the next save re-baselines.
      const { fmBlock, body } = splitFrontmatter(session.sourceText);
      const pendingChange = session.fmChanged || session.sourceChanged || session.dirty;
      patch({
        mode: 'wysiwyg',
        fmBlock,
        originalBody: body,
        bodyBaseline: null,
        bodyCurrent: null,
        fmChanged: pendingChange,
        dirty: pendingChange,
        generation: session.generation + 1,
      });
    }
  },

  /** Persist if dirty. No edits → no write (zero-diff trivially holds). */
  async save(): Promise<void> {
    if (!session || !session.dirty || session.saving) return;
    const path = session.path;
    const content = compose(session);
    lastWritten.set(path, content);
    patch({ saving: true, saveError: null });
    try {
      await pipeline.dispatch('doc.save', { path, content });
      if (session && session.path === path) {
        // Re-baseline: what's on disk is now the session's clean state.
        const { fmBlock, body } = splitFrontmatter(content);
        patch({
          fmBlock,
          originalBody: body,
          bodyBaseline: session.bodyCurrent,
          sourceText: content,
          sourceBaseline: content,
          sourceChanged: false,
          fmChanged: false,
          dirty: false,
          saving: false,
          externalConflict: false,
        });
      }
    } catch (err) {
      if (session && session.path === path) {
        patch({
          saving: false,
          saveError: err instanceof Error ? err.message : String(err),
        });
      }
    }
  },

  /** ISR entry: the watched file changed on disk. */
  async handleDiskChange(path: string, readDisk: () => Promise<DocContent>): Promise<void> {
    if (!session || session.path !== path) return;
    let content: DocContent;
    try {
      content = await readDisk();
    } catch {
      return;
    }
    // Echo of our own write → no information, skip.
    if (lastWritten.get(path) === content.raw) {
      console.log(`[ISR doc-projection] 回声已去重（盘上内容 = 内存状态）: ${path}`);
      return;
    }
    if (!session.dirty) {
      console.log(`[ISR doc-projection] 真实外部修改 → 重载编辑器: ${path}`);
      this.openSession(content); // live-follow external edits
    } else {
      console.log(`[ISR doc-projection] 外部修改撞上未保存编辑 → 标记冲突: ${path}`);
      patch({ externalConflict: true });
    }
  },

  /** The watched file disappeared. */
  handleDiskUnlink(path: string): void {
    if (!session || session.path !== path) return;
    session = null;
    emit();
  },

  /** Used by doc-switch flows: persist pending edits before moving on. */
  async flushBeforeSwitch(): Promise<void> {
    await this.save();
  },
};

export function useEditorSession(): EditorSession | null {
  return useSyncExternalStore(
    (onStoreChange) => {
      subscribers.add(onStoreChange);
      return () => {
        subscribers.delete(onStoreChange);
      };
    },
    () => session,
  );
}

/** Read query helper for the ISR (kept here to avoid project-store import). */
export async function readDocFromDisk(path: string): Promise<DocContent> {
  return window.api.invoke<{ path: string }, DocContent>(CHANNELS.DOC_READ, { path });
}
