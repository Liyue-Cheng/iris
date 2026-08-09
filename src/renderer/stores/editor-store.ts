/**
 * Editing-session coordinator.
 *
 * Pure document transitions live in lib/editor-session.ts. This module owns
 * only runtime orchestration: subscriptions, autosave timers, serialized IPC
 * writes, watcher echo dedup and external-conflict recovery.
 */
import { useSyncExternalStore } from 'react';
import { CHANNELS } from '@shared/protocol';
import type { DocContent, EditorConflictPolicy } from '@shared/types';
import {
  getFrontmatterKey,
  setFrontmatterKey,
  splitFrontmatter,
} from '@shared/markdown-utils';
import { pipeline } from '@renderer/cpu';
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
  type EditorDocumentState,
  type EditorMode,
} from '@renderer/lib/editor-session';
import { getSettings } from './settings-store';
import { projectScopeState, sameProjectScope } from './project-scope-state';
import { translate } from '@renderer/i18n';

export type { EditorMode };

export interface EditorSession extends EditorDocumentState {
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  conflict: DocContent | null;
  generation: number;
  bodyHydrating: boolean;
}

export type SaveTrigger =
  | 'manual'
  | 'body-idle'
  | 'editor-blur'
  | 'checkbox-toggle'
  | 'frontmatter-commit'
  | 'view-switch'
  | 'project-switch'
  | 'before-quit'
  | 'before-external-action';

export type SaveResult =
  | { status: 'noop' }
  | { status: 'saved' }
  | { status: 'blocked'; reason: 'external-conflict' }
  | { status: 'failed'; error: string };

interface SaveSnapshot {
  path: string;
  content: string;
  expectedContent: string | null;
  revision: number;
  bodyCurrent: string | null;
}

const DEFAULT_AUTOSAVE_DELAY_MS = 1500;
const TASK_CHECKBOX = /^(\s*(?:[-*+]|\d+\.)\s+)\[[ xX]\]/gm;

let session: EditorSession | null = null;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();
const lastWritten = new Map<string, string>();
const pendingSaves = new Map<string, SaveSnapshot>();
const saveJobs = new Map<string, Promise<void>>();
const inFlightTargets = new Map<string, string>();

function emit(): void {
  subscribers.forEach((cb) => cb());
}

function withDerived(next: EditorSession): EditorSession {
  return { ...next, dirty: isEditorDocumentDirty(next) };
}

function replace(next: EditorSession): void {
  session = withDerived(next);
  emit();
}

function patch(update: Partial<EditorSession>): void {
  if (!session) return;
  replace({ ...session, ...update });
}

function replaceDocument(next: EditorDocumentState, update: Partial<EditorSession> = {}): void {
  if (!session) return;
  replace({ ...session, ...next, ...update });
}

function clearAutosave(): void {
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = null;
}

function behavior(): {
  autosave: boolean;
  delayMs: number;
  saveOnBlur: boolean;
  conflictPolicy: EditorConflictPolicy;
} {
  const settings = getSettings()?.behavior;
  return {
    autosave: settings?.editorAutosave ?? true,
    delayMs: settings?.editorAutosaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_MS,
    saveOnBlur: settings?.editorSaveOnBlur ?? true,
    conflictPolicy: settings?.editorConflictPolicy ?? 'ask',
  };
}

function scheduleAutosave(): void {
  clearAutosave();
  const current = session;
  const settings = behavior();
  if (!current?.dirty || !settings.autosave) return;
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void editorStore.save('body-idle');
  }, settings.delayMs);
}

function isPureCheckboxToggle(prev: string, next: string): boolean {
  if (prev === next) return false;
  const strip = (value: string): string => value.replace(TASK_CHECKBOX, '$1[ ]');
  return strip(prev) === strip(next);
}

function isWriteConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('WriteConflict');
}

async function registerWriteConflict(path: string): Promise<void> {
  try {
    const content = await readDocFromDisk(path);
    if (session?.path === path) {
      patch({ conflict: content, saveError: null });
    }
  } catch (error) {
    if (session?.path === path) {
      patch({ saveError: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function drainSaveQueue(path: string): Promise<void> {
  while (true) {
    const snapshot = pendingSaves.get(path);
    if (!snapshot) return;
    pendingSaves.delete(path);
    inFlightTargets.set(path, snapshot.content);

    const previousWritten = lastWritten.get(path);
    lastWritten.set(path, snapshot.content);
    if (session?.path === path) patch({ saving: true, saveError: null });

    try {
      await pipeline.dispatch('doc.save', {
        path,
        content: snapshot.content,
        expectedContent: snapshot.expectedContent,
      });
      if (session?.path === path) {
        replaceDocument(
          advanceBaselineAfterSave(
            session,
            snapshot.content,
            snapshot.bodyCurrent,
            snapshot.revision,
          ),
          { conflict: null, saveError: null },
        );
      }
    } catch (error) {
      if (lastWritten.get(path) === snapshot.content) {
        if (previousWritten === undefined) lastWritten.delete(path);
        else lastWritten.set(path, previousWritten);
      }

      if (isWriteConflict(error)) {
        await registerWriteConflict(path);
        if (behavior().conflictPolicy === 'overwrite') {
          // A newer revision may have been queued while this write was in
          // flight. Retry that newest snapshot, never the stale one that
          // conflicted, and make the overwrite authorization explicit.
          const queued = pendingSaves.get(path);
          pendingSaves.set(path, {
            ...(queued ?? snapshot),
            expectedContent: null,
          });
          continue;
        }
      } else if (session?.path === path) {
        patch({ saveError: error instanceof Error ? error.message : String(error) });
      }

      pendingSaves.delete(path);
      return;
    } finally {
      if (session?.path === path && !pendingSaves.has(path)) patch({ saving: false });
    }
  }
}

function startSaveJob(path: string): Promise<void> {
  const existing = saveJobs.get(path);
  if (existing) return existing;
  const job = drainSaveQueue(path).finally(() => {
    saveJobs.delete(path);
    inFlightTargets.delete(path);
  });
  saveJobs.set(path, job);
  return job;
}

async function waitForSaveDrain(path: string): Promise<void> {
  while (pendingSaves.has(path) || saveJobs.has(path)) {
    await startSaveJob(path);
  }
}

async function applyFmBlock(fmBlock: string): Promise<void> {
  if (!session) return;
  if (session.mode === 'source') {
    const { body } = splitFrontmatter(session.sourceText);
    const next = updateSourceText(session, fmBlock + body);
    if (next === session) return;
    replaceDocument({ ...next, fmBlock });
    await editorStore.save('frontmatter-commit');
    return;
  }
  const next = updateFrontmatterBlock(session, fmBlock);
  if (next === session) return;
  replaceDocument(next);
  await editorStore.save('frontmatter-commit');
}

export const editorStore = {
  get(): EditorSession | null {
    return session;
  },

  openSession(content: DocContent): void {
    clearAutosave();
    const generation = session?.path === content.path ? session.generation + 1 : 1;
    const document = createEditorDocument(content);
    session = withDerived({
      ...document,
      saving: false,
      saveError: null,
      conflict: null,
      generation,
      bodyHydrating: true,
      dirty: false,
    });
    lastWritten.set(content.path, content.raw);
    emit();
  },

  closeSession(): void {
    clearAutosave();
    session = null;
    emit();
  },

  /** Crepe initialization is explicitly non-user state. Stale lifecycle
   * callbacks are rejected by path + generation. */
  finishBodyHydration(path: string, generation: number, markdown: string): void {
    if (
      !session ||
      session.path !== path ||
      session.generation !== generation ||
      session.mode !== 'wysiwyg'
    ) {
      return;
    }
    replaceDocument(hydrateWysiwygBody(session, markdown), { bodyHydrating: false });
  },

  setBodyFromEditor(path: string, generation: number, markdown: string): void {
    if (
      !session ||
      session.path !== path ||
      session.generation !== generation ||
      session.bodyHydrating
    ) {
      return;
    }
    const previous = session.bodyCurrent;
    const next = updateWysiwygBody(session, markdown);
    if (next === session) return;
    replaceDocument(next);
    if (previous !== null && isPureCheckboxToggle(previous, markdown)) {
      clearAutosave();
      void editorStore.save('checkbox-toggle');
    } else {
      scheduleAutosave();
    }
  },

  setSourceText(path: string, generation: number, text: string): void {
    if (!session || session.path !== path || session.generation !== generation) return;
    const next = updateSourceText(session, text);
    if (next === session) return;
    replaceDocument(next);
    scheduleAutosave();
  },

  async setFrontmatterField(key: string, value: string): Promise<void> {
    if (!session) return;
    const fmBlock =
      session.mode === 'source' ? splitFrontmatter(session.sourceText).fmBlock : session.fmBlock;
    await applyFmBlock(setFrontmatterKey(fmBlock, key, value));
  },

  getFrontmatterField(key: string): string | null {
    if (!session) return null;
    const fmBlock =
      session.mode === 'source' ? splitFrontmatter(session.sourceText).fmBlock : session.fmBlock;
    return getFrontmatterKey(fmBlock, key);
  },

  toggleMode(): void {
    if (!session) return;
    clearAutosave();
    const next = toggleEditorMode(session);
    replaceDocument(next, {
      generation: session.generation + 1,
      bodyHydrating: next.mode === 'wysiwyg',
    });
    scheduleAutosave();
  },

  async save(
    _trigger: SaveTrigger = 'manual',
    options: { forceOverwrite?: boolean } = {},
  ): Promise<SaveResult> {
    clearAutosave();
    if (!session) return { status: 'noop' };

    const current = session;
    const conflictPolicy = behavior().conflictPolicy;
    const decision = decideEditorSave(
      current,
      current.conflict,
      conflictPolicy,
      options.forceOverwrite ?? false,
    );
    if (decision.kind === 'noop') {
      if (current.saveError) patch({ saveError: null });
      return { status: 'noop' };
    }
    if (decision.kind === 'blocked') return { status: 'blocked', reason: decision.reason };

    const expectedContent = options.forceOverwrite || (current.conflict && conflictPolicy === 'overwrite')
      ? null
      : (inFlightTargets.get(current.path) ?? current.baselineRaw);
    pendingSaves.set(current.path, {
      path: current.path,
      content: decision.content,
      expectedContent,
      revision: current.revision,
      bodyCurrent: current.mode === 'wysiwyg' ? current.bodyCurrent : null,
    });
    await waitForSaveDrain(current.path);

    const latest = session?.path === current.path ? session : null;
    if (latest?.saveError) return { status: 'failed', error: latest.saveError };
    if (latest?.conflict && behavior().conflictPolicy === 'ask') {
      return { status: 'blocked', reason: 'external-conflict' };
    }
    return { status: 'saved' };
  },

  handleEditorBlur(): void {
    if (behavior().saveOnBlur) void this.save('editor-blur');
  },

  async flushBeforeSwitch(trigger: SaveTrigger = 'view-switch'): Promise<boolean> {
    const result = await this.save(trigger);
    return result.status === 'noop' || result.status === 'saved';
  },

  async flushBeforeProjectSwitch(): Promise<void> {
    const result = await this.save('project-switch');
    if (result.status === 'blocked') throw new Error(translate('error.externalConflict'));
    if (result.status === 'failed') throw new Error(result.error);
  },

  async overwriteConflict(): Promise<SaveResult> {
    return this.save('manual', { forceOverwrite: true });
  },

  reloadConflict(): void {
    if (session?.conflict) this.openSession(session.conflict);
  },

  async handleDiskChange(path: string, readDisk: () => Promise<DocContent>): Promise<void> {
    if (!session || session.path !== path) return;
    let content: DocContent;
    try {
      content = await readDisk();
    } catch {
      return;
    }
    if (lastWritten.get(path) === content.raw || content.raw === session.baselineRaw) return;
    if (!session.dirty) this.openSession(content);
    else patch({ conflict: content });
  },

  handleDiskUnlink(path: string): void {
    if (session?.path === path) this.closeSession();
  },
};

export function useEditorSession(): EditorSession | null {
  return useSyncExternalStore(
    (onStoreChange) => {
      subscribers.add(onStoreChange);
      return () => subscribers.delete(onStoreChange);
    },
    () => session,
  );
}

export async function readDocFromDisk(path: string): Promise<DocContent> {
  const scope = projectScopeState.get();
  if (!scope) throw new Error('[doc:read] no active project scope');
  const content = await window.api.invoke<
    { path: string; expectedScope: typeof scope },
    DocContent
  >(CHANNELS.DOC_READ, { path, expectedScope: scope });
  if (!sameProjectScope(scope, projectScopeState.get())) {
    throw new Error('[doc:read] stale project response');
  }
  return content;
}

export function editorConflictPolicy(): EditorConflictPolicy {
  return behavior().conflictPolicy;
}

export function editorComposedText(): string | null {
  return session ? composeEditorDocument(session) : null;
}
