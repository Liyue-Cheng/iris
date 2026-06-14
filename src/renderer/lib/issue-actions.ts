/**
 * Inline frontmatter edits from the issue panel (currently just status).
 * Reuses the doc.save instruction with the same surgical-frontmatter
 * discipline as the typed header — and routes through the live editing
 * session when the target doc happens to be open (otherwise the panel
 * write and the editor would race).
 */
import { setFrontmatterKey, splitFrontmatter } from '@shared/markdown-utils';
import { pipeline } from '@renderer/cpu';
import { editorStore, readDocFromDisk } from '@renderer/stores/editor-store';

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
  await pipeline.dispatch('doc.save', { path, content: nextFm + body });
}

export async function setDocStatus(path: string, status: string): Promise<void> {
  await setDocField(path, 'status', status);
}
