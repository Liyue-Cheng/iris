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
import { isResolvedIssueStatus } from '@renderer/lib/doc-utils';
import { translate } from '@renderer/i18n';
import { getSettings } from '@renderer/stores/settings-store';

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

function typedFolder(path: string): 'issue' | 'report' | null {
  const segments = path.replace(/\\/g, '/').split('/');
  for (let i = segments.length - 2; i >= 0; i--) {
    const segment = segments[i];
    if (segment === 'issue' || segment === 'report') return segment;
    if (segment === 'status' || segment === 'misc') return null;
  }
  return null;
}

/** A status that removes the document from its active lens. */
export function statusClosesDocument(path: string, status: string): boolean {
  const normalized = status.trim().toLowerCase();
  const type = typedFolder(path);
  return type === 'issue'
    ? isResolvedIssueStatus(status)
    : type === 'report' && normalized === 'backlog';
}

export async function setDocStatus(path: string, status: string): Promise<void> {
  await setDocsStatus([path], status);
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
 * terminal anchored to those documents, so a hidden issue/report never keeps
 * inaccessible sessions alive. One bulk action produces one confirmation.
 */
export async function setDocsStatus(paths: readonly string[], status: string): Promise<void> {
  const uniquePaths = [...new Set(paths)];
  const closingPaths = new Set(uniquePaths.filter((path) => statusClosesDocument(path, status)));
  const anchored = sessionStore
    .get()
    .sessions.filter((session) => session.docPath !== null && closingPaths.has(session.docPath));

  if (anchored.length > 0) {
    const documentCount = new Set(anchored.map((session) => session.docPath)).size;
    const subject = documentCount === 1
      ? translate('collection.oneDocument')
      : translate('collection.manyDocuments', { count: documentCount });
    const confirmed = await confirmDialog({
      title: translate('collection.closeLinkedTitle'),
      message: translate('collection.closeLinkedMessage', {
        documents: subject,
        sessions: anchored.length,
        status,
      }),
      confirmText: translate('collection.closeAndChange'),
      tone: 'destructive',
    });
    if (!confirmed) return;

    // Re-read after the dialog: sessions may have been opened or closed while
    // the confirmation was visible, and "all" must describe current reality.
    const currentAnchored = sessionStore
      .get()
      .sessions.filter((session) => session.docPath !== null && closingPaths.has(session.docPath));
    await Promise.all(
      currentAnchored.map((session) =>
        pipeline.dispatch('session.close', { sessionId: session.id }),
      ),
    );
  }

  const shouldCheckTodos =
    status.trim().toLowerCase() === 'done' &&
    (getSettings()?.behavior.autoCheckTodosOnDone ?? false);
  await Promise.all(
    uniquePaths.map((path) =>
      setDocStatusField(path, status, shouldCheckTodos && typedFolder(path) === 'issue'),
    ),
  );
}
