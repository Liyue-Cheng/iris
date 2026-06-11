/**
 * Read-only single-doc view (M1). Typed header (badges) + remark-rendered
 * body. The full typed header with editable frontmatter fields and the
 * Crepe WYSIWYG editor replace this in M2 — the layout skeleton (header
 * owns frontmatter, body below) is already the final shape.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileWarning, Loader2 } from 'lucide-react';
import type { DocType } from '@shared/types';
import { useProject } from '@renderer/stores/project-store';
import { cn } from '@renderer/lib/utils';

const TYPE_BADGE: Record<DocType, string> = {
  status: 'bg-[var(--rp-pine)] text-[var(--rp-base)]',
  issue: 'bg-[var(--rp-gold)] text-[var(--rp-base)]',
  report: 'bg-[var(--rp-foam)] text-[var(--rp-base)]',
  misc: 'bg-[var(--rp-highlight-high)] text-foreground',
};

function typeOfPath(path: string): DocType | null {
  const segments = path.split('/');
  for (let i = segments.length - 2; i >= 0; i--) {
    const s = segments[i];
    if (s === 'status' || s === 'issue' || s === 'report' || s === 'misc') return s;
  }
  return null;
}

export function DocPreview(): JSX.Element {
  const { selectedPath, docContent, docLoading } = useProject();

  if (!selectedPath) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        从左栏选择一篇文档
      </div>
    );
  }

  if (docLoading && !docContent) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!docContent) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-destructive">
        读取失败：{selectedPath}
      </div>
    );
  }

  const type = typeOfPath(docContent.path);
  const fm = docContent.frontmatter;
  const title = typeof fm?.title === 'string' ? fm.title : null;
  const status = typeof fm?.status === 'string' ? fm.status : null;

  return (
    <div className="flex h-full flex-col">
      {/* Typed header — owns the frontmatter; the body editor never sees it. */}
      <div className="shrink-0 border-b bg-card/30 px-6 py-3">
        <div className="flex items-center gap-2">
          {type && (
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                TYPE_BADGE[type],
              )}
            >
              {type}
            </span>
          )}
          {status && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {status}
            </span>
          )}
          {docContent.frontmatterBroken && (
            <span className="flex items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 text-[11px] text-destructive">
              <FileWarning className="h-3 w-3" />
              frontmatter 损坏 — 已按无元数据降级
            </span>
          )}
          <span className="ml-auto truncate text-[11px] text-muted-foreground/70">
            {docContent.path}
          </span>
        </div>
        <h1 className="mt-1 truncate text-lg font-semibold">
          {title ?? docContent.path.split('/').pop()?.replace(/\.md$/i, '')}
        </h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="markdown-body mx-auto max-w-3xl px-6 py-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{docContent.body}</ReactMarkdown>
        </article>
      </div>
    </div>
  );
}
