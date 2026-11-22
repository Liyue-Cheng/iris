/**
 * Inline frontmatter edits from the issue panel (currently just status).
 * Reuses the doc.save instruction with the same surgical-frontmatter
 * discipline as the typed header — and routes through the live editing
 * session when the target doc happens to be open (otherwise the panel
 * write and the editor would race).
 */
import { checkAllDocTaskCheckboxes, setDocField as withDocField } from '@shared/doc-fields';
import { pipeline } from '@renderer/cpu';
import { confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { editorStore, readDocFromDisk } from '@renderer/stores/editor-store';
import { CHANNELS } from '@shared/protocol';
import type { DocumentSessionTarget } from '@shared/types';
import {
  describeDocumentSession,
  planDocumentStatusTransition,
  type StatusDocumentType,
  type StatusTransitionPlan,
} from '@shared/document-status';
import { translate } from '@renderer/i18n';
import { getSettings } from '@renderer/stores/settings-store';
import { runProjectAction } from './action-runtime';
import { AppError } from '@shared/app-error';
import { projectScopeState, sameProjectScope } from '@renderer/stores/project-scope-state';

export async function setDocField(path: string, key: string, value: string): Promise<void> {
  const scope = projectScopeState.get();
  const session = editorStore.get();
  if (session?.path === path) {
    await editorStore.setFrontmatterField(key, value);
    const edited = editorStore.get();
    if (edited?.path === path && (edited.saveError || edited.conflict)) {
      throw new Error(edited.saveError ?? translate('collection.statusSaveConflict'));
    }
    return;
  }
  const content = await readDocFromDisk(path);
  if (!sameProjectScope(scope, projectScopeState.get())) throw new AppError('document', 'Cancelled', 'Document action retired');
  if (content.frontmatterBroken) throw new Error(translate('collection.statusInvalidHeader'));
  const nextRaw = withDocField(path, content.raw, key, value);
  if (nextRaw === content.raw) return; // malformed block — refuse to guess
  await pipeline.dispatch('doc.save', {
    path,
    content: nextRaw,
    expectedContent: content.raw,
  });
}

function typedFolder(path: string): StatusDocumentType | null {
  const segments = path.replace(/\\/g, '/').split('/');
  for (let i = segments.length - 2; i >= 0; i--) {
    const segment = segments[i];
    if (segment === 'issue' || segment === 'report' || segment === 'status' || segment === 'misc') return segment;
  }
  return null;
}

/** Pure plan for the side effects Iris owns when it initiates a status change. */
export function planStatusTransition(
  path: string,
  status: string,
  autoCheckTodosOnDone: boolean,
): StatusTransitionPlan {
  return planDocumentStatusTransition(typedFolder(path), status, autoCheckTodosOnDone);
}

export async function setDocStatus(path: string, status: string): Promise<void> {
  await runProjectAction(
    {
      title: translate('errors.statusUpdateFailed'),
      dedupeKey: `document:status:${path}`,
    },
    () => setDocsStatus([path], status),
  );
}

async function setDocStatusField(
  path: string,
  status: string,
  checkTodos: boolean,
): Promise<void> {
  const scope = projectScopeState.get();
  if (!checkTodos) {
    await setDocField(path, 'status', status);
    return;
  }
  if (editorStore.get()?.path === path) {
    if (!(await editorStore.flushBeforeSwitch('before-external-action'))) throw new Error(translate('collection.statusSaveConflict'));
  }
  const content = await readDocFromDisk(path);
  if (!sameProjectScope(scope, projectScopeState.get())) throw new AppError('document', 'Cancelled', 'Document action retired');
  if (content.frontmatterBroken) throw new Error(translate('collection.statusInvalidHeader'));
  const nextRaw = checkAllDocTaskCheckboxes(path, withDocField(path, content.raw, 'status', status));
  if (nextRaw === content.raw) return;
  await pipeline.dispatch('doc.save', {
    path,
    content: nextRaw,
    expectedContent: content.raw,
  });
}

/**
 * Move one or more documents to a status. Closing states first settle every
 * session anchored to those documents — terminals and Iris Agent instances
 * alike — so a hidden issue/report never keeps inaccessible sessions alive.
 * One bulk action produces one confirmation.
 */
export async function setDocsStatus(paths: readonly string[], status: string): Promise<boolean> {
  const scope = projectScopeState.get();
  const isCurrent = (): boolean => sameProjectScope(scope, projectScopeState.get());
  const uniquePaths = [...new Set(paths)];
  const autoCheckTodosOnDone = getSettings()?.behavior.autoCheckTodosOnDone ?? false;
  const plans = new Map(
    uniquePaths.map((path) => [
      path,
      planStatusTransition(path, status, autoCheckTodosOnDone),
    ]),
  );
  const documentPaths = uniquePaths.filter(path => plans.get(path)?.closeSessions);
  let closed: DocumentSessionTarget[] = [];
  if (documentPaths.length > 0) {
    const query = { expectedScope: scope, documentPaths };
    const targets = await window.api.invoke<typeof query, DocumentSessionTarget[]>(CHANNELS.DOCUMENT_SESSIONS_LIST, query);
    if (!isCurrent()) return false;
    if (targets.length) {
      const documentCount = new Set(targets.map(target => target.documentPath)).size;
      const sessions = targets.filter(target => target.kind === 'terminal').length;
      const confirmed = await confirmDialog({
        title: translate('collection.closeLinkedTitle'),
        message: translate('collection.closeLinkedMessage', {
          documents: documentCount === 1 ? translate('collection.oneDocument')
            : translate('collection.manyDocuments', { count: documentCount }),
          sessions, agents: targets.length - sessions, status,
        }) + '\n\n' + targets.map(describeDocumentSession).join('\n'),
        confirmText: translate('collection.closeAndChange'),
        tone: 'destructive',
      });
      if (!confirmed || !isCurrent()) return false;
    }
    const request = { ...query, confirmed: targets };
    closed = await window.api.invoke<typeof request, DocumentSessionTarget[]>(CHANNELS.DOCUMENT_SESSIONS_CLOSE, request);
    if (!isCurrent()) return false;
  }
  const writes = await Promise.allSettled(uniquePaths.map(path =>
    setDocStatusField(path, status, plans.get(path)?.checkTodos ?? false)));
  const failed = writes.flatMap((result, i) => result.status === 'rejected'
    ? [uniquePaths[i] + ' (' + String(result.reason) + ')'] : []);
  if (failed.length) {
    const summary = translate('collection.linkedPartial', { count: closed.length, reason: failed.join(', ') });
    throw new AppError('document', 'StatusSaveFailed', [summary, ...closed.map(describeDocumentSession)].join('\n'), {
      details: { closed },
    });
  }
  return true;
}
