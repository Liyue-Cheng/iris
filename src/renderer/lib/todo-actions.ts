/**
 * Check one task line from the todo panel — single-line byte surgery on
 * the doc body, same discipline as issue-actions but aimed at a body line
 * instead of a frontmatter key.
 *
 * Safety: the write only happens when the target line on disk is still
 * byte-identical to what the scan recorded (todo.raw). Anything else means
 * the doc moved under us — refuse, let the next scan re-project. If the
 * doc is open in the editor, pending edits are flushed first so disk is
 * the single source of truth; the watcher then live-reloads the (clean)
 * session with the checked box, via the existing doc-projection ISR.
 */
import type { DocTodo } from '@shared/types';
import { pipeline } from '@renderer/cpu';
import { editorStore, readDocFromDisk } from '@renderer/stores/editor-store';

/** @returns false when the edit was refused (stale line) — not an error. */
export async function checkTodo(docPath: string, todo: DocTodo): Promise<boolean> {
  if (editorStore.get()?.path === docPath) {
    await editorStore.flushBeforeSwitch();
  }
  const content = await readDocFromDisk(docPath);
  // Split keeping each line's EOL so the re-join is byte-exact.
  const lines = content.raw.split(/(?<=\n)/);
  const line = lines[todo.line];
  if (line === undefined || line.replace(/\r?\n$/, '') !== todo.raw) {
    console.warn(
      `[todo] ${docPath}:${todo.line + 1} changed since scan — refusing blind edit`,
    );
    return false;
  }
  // First '[ ]' in the line is the checkbox (it precedes the task text).
  lines[todo.line] = line.replace('[ ]', '[x]');
  await pipeline.dispatch('doc.save', { path: docPath, content: lines.join('') });
  return true;
}
