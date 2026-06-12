/**
 * Drag-a-doc-into-the-terminal support. Drag sources (lens tree rows,
 * collection list rows) stamp the doc path under a custom MIME type;
 * TerminalView's drop handler reads the file and pastes a metadata
 * header plus the full text through the single paste path.
 *
 * text/plain carries the bare path as well, so dragging a row into an
 * external editor or terminal still yields something meaningful.
 */
import type { DocContent } from '@shared/types';

export const IRIS_DOC_MIME = 'application/x-iris-doc';

/** Inline-snapshot cap; bigger docs paste a pointer instead (32 KiB — the
 *  same default ceiling Codex applies to AGENTS.md). */
export const DOC_PASTE_MAX_BYTES = 32 * 1024;

export function setDocDragData(dt: DataTransfer, docPath: string): void {
  dt.setData(IRIS_DOC_MIME, docPath);
  dt.setData('text/plain', docPath);
  dt.effectAllowed = 'copy';
}

export function isDocDrag(dt: DataTransfer): boolean {
  return dt.types.includes(IRIS_DOC_MIME);
}

export function getDocDragPath(dt: DataTransfer): string | null {
  return dt.getData(IRIS_DOC_MIME) || null;
}

const TYPED_FOLDERS = ['status', 'issue', 'report', 'misc'];

/** "类型 issue，工作区 .iris" — both derived from the path (名字即类型). */
function describePath(path: string): string {
  const segments = path.split('/');
  for (let i = segments.length - 2; i >= 0; i--) {
    const seg = segments[i];
    if (seg !== undefined && TYPED_FOLDERS.includes(seg)) {
      const workspace = segments.slice(0, i).join('/') || '.';
      return `类型 ${seg}，工作区 ${workspace}`;
    }
  }
  return '类型未知';
}

/**
 * Metadata header + snapshot. The "写回以盘上文件为准" line keeps the
 * pasted copy from being treated as current truth — files are the
 * contract, a paste is a point-in-time snapshot.
 */
export function composeDocPasteBlock(doc: DocContent): string {
  const status =
    typeof doc.frontmatter?.['status'] === 'string'
      ? `，status: ${doc.frontmatter['status']}`
      : '';
  const header = `[Iris] 文档粘贴: ${doc.path}（${describePath(doc.path)}${status}）`;
  // ESC stripped wholesale: a markdown doc has no business carrying
  // control bytes, and a literal \x1b[201~ inside the body would break
  // out of the bracketed-paste wrap (paste injection).
  const text = doc.raw.replace(/\x1b/g, '');
  if (new TextEncoder().encode(text).length > DOC_PASTE_MAX_BYTES) {
    return `${header}\n—— 文档超过 32 KiB，未内联快照，请直接读取该文件 ——\n`;
  }
  return `${header}\n—— 以下为拖入时快照，写回以盘上文件为准 ——\n${text}\n`;
}
