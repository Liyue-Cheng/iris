/**
 * Inline frontmatter edits from the issue panel (currently just status).
 * Reuses the doc.save instruction with the same surgical-frontmatter
 * discipline as the typed header — and routes through the live editing
 * session when the target doc happens to be open (otherwise the panel
 * write and the editor would race).
 */
import {
  checkAllTaskCheckboxes,
  setFrontmatterKey,
  splitFrontmatter,
} from '@shared/markdown-utils';
import { pipeline } from '@renderer/cpu';
import { confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { editorStore, readDocFromDisk } from '@renderer/stores/editor-store';
import { sessionStore } from '@renderer/stores/session-store';
import { archiveIrisAgentDocuments, countIrisAgentDocuments } from './iris-agent-actions';
import {
  planDocumentStatusTransition,
  type StatusDocumentType,
  type StatusTransitionPlan,
} from '@shared/document-status';
import { translate } from '@renderer/i18n';
import { getSettings } from '@renderer/stores/settings-store';
import { runUserAction } from './action-runtime';

export async function setDocField(path: string, key: string, value: string): Promise<void> {
  const session = editorStore.get();
  if (session?.path === path) {
    await editorStore.setFrontmatterField(key, value);
    return;
  }
  const content = await readDocFromDisk(path);
  const { fmBlock, body } = splitFrontmatter(content.raw);
  const nextFm = setFrontmatterKey(fmBlock, key, value);
  if (nextFm === fmBlock) return; // malformed block — refuse to guess
  await pipeline.dispatch('doc.save', {
    path,
    content: nextFm + body,
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
  await runUserAction(
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
  if (!checkTodos) {
    await setDocField(path, 'status', status);
    return;
  }
  if (editorStore.get()?.path === path) {
    if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return;
  }
  const content = await readDocFromDisk(path);
  if (content.frontmatterBroken) return;
  const { fmBlock, body } = splitFrontmatter(content.raw);
  const nextFm = setFrontmatterKey(fmBlock, 'status', status);
  const nextRaw = checkAllTaskCheckboxes(nextFm + body);
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
export async function setDocsStatus(paths: readonly string[], status: string): Promise<void> {
  const uniquePaths = [...new Set(paths)];
  const autoCheckTodosOnDone = getSettings()?.behavior.autoCheckTodosOnDone ?? false;
  const plans = new Map(
    uniquePaths.map((path) => [
      path,
      planStatusTransition(path, status, autoCheckTodosOnDone),
    ]),
  );
  const closingPaths = new Set(
    uniquePaths.filter((path) => plans.get(path)?.closeSessions ?? false),
  );
  const anchored = sessionStore
    .get()
    .sessions.filter((session) => session.docPath !== null && closingPaths.has(session.docPath));
  const anchoredAgentCount = await countIrisAgentDocuments([...closingPaths]);

  if (anchored.length > 0 || anchoredAgentCount > 0) {
    const documentCount = anchoredAgentCount > 0
      ? closingPaths.size
      : new Set(anchored.map((session) => session.docPath)).size;
    const subject = documentCount === 1
      ? translate('collection.oneDocument')
      : translate('collection.manyDocuments', { count: documentCount });
    const confirmed = await confirmDialog({
      title: translate('collection.closeLinkedTitle'),
      message: translate('collection.closeLinkedMessage', {
        documents: subject,
        sessions: anchored.length,
        agents: anchoredAgentCount,
        status,
      }),
      confirmText: translate('collection.closeAndChange'),
      tone: 'destructive',
    });
    if (!confirmed) return;

  }

  if (closingPaths.size > 0) {
    // Re-read after the dialog: sessions may have been opened or closed while
    // it was visible. Main also re-enumerates Agent anchors authoritatively.
    const currentAnchored = sessionStore
      .get()
      .sessions.filter((session) => session.docPath !== null && closingPaths.has(session.docPath));
    await Promise.all([
      ...currentAnchored.map((session) =>
        pipeline.dispatch('session.close', { sessionId: session.id }),
      ),
      archiveIrisAgentDocuments([...closingPaths]),
    ]);
  }

  await Promise.all(
    uniquePaths.map((path) =>
      setDocStatusField(path, status, plans.get(path)?.checkTodos ?? false),
    ),
  );
}
