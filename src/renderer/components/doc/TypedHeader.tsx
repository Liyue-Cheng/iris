/**
 * The typed header — sole owner of the frontmatter UI (the body editor
 * never sees it). Title and status edit surgically (one key line each,
 * everything else byte-preserved) and persist immediately.
 *
 * `status:` is a SOFT value: the input offers the soft state machine as
 * datalist suggestions but accepts anything (键是硬的，值是软的).
 */
import { useEffect, useState } from 'react';
import { Check, Code2, Eye, FileWarning, Loader2, TriangleAlert } from 'lucide-react';
import type { DocType } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { editorStore, type EditorSession } from '@renderer/stores/editor-store';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';

const TYPE_BADGE: Record<DocType, string> = {
  status: 'bg-[var(--rp-pine)] text-[var(--rp-base)]',
  issue: 'bg-[var(--rp-gold)] text-[var(--rp-base)]',
  report: 'bg-[var(--rp-foam)] text-[var(--rp-base)]',
  misc: 'bg-[var(--rp-highlight-high)] text-foreground',
};

const SOFT_STATUSES = ['todo', 'in_progress', 'blocked', 'done'];

export function typeOfPath(path: string): DocType | null {
  const segments = path.split('/');
  for (let i = segments.length - 2; i >= 0; i--) {
    const s = segments[i];
    if (s === 'status' || s === 'issue' || s === 'report' || s === 'misc') return s;
  }
  return null;
}

function FieldInput({
  value,
  placeholder,
  disabled,
  onCommit,
  className,
  list,
}: {
  value: string;
  placeholder: string;
  disabled: boolean;
  onCommit: (v: string) => void;
  className?: string;
  list?: string;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = (): void => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };

  return (
    <input
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      {...(list !== undefined ? { list } : {})}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
      className={cn(
        'rounded-sm bg-transparent outline-none transition-colors hover:bg-muted/60 focus:bg-muted/60 disabled:hover:bg-transparent',
        className,
      )}
    />
  );
}

export function TypedHeader({ session }: { session: EditorSession }): JSX.Element {
  const type = typeOfPath(session.path);
  const title = editorStore.getFrontmatterField('title') ?? '';
  const status = editorStore.getFrontmatterField('status') ?? '';
  // A structurally broken frontmatter block is shown, never auto-edited.
  const fmEditable = !looksBroken(session.fmBlock);

  return (
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

        <FieldInput
          value={status}
          placeholder="status…"
          disabled={!fmEditable}
          onCommit={(v) => void editorStore.setFrontmatterField('status', v)}
          list="iris-soft-statuses"
          className="w-32 px-1.5 py-0.5 text-[11px] text-muted-foreground"
        />
        <datalist id="iris-soft-statuses">
          {SOFT_STATUSES.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>

        {!fmEditable && (
          <span className="flex items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 text-[11px] text-destructive">
            <FileWarning className="h-3 w-3" />
            frontmatter 异常 — 字段编辑已禁用，可用源码模式修复
          </span>
        )}

        {session.externalConflict && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1 rounded bg-[var(--rp-gold)]/20 px-1.5 py-0.5 text-[11px] text-[var(--rp-gold)]">
                <TriangleAlert className="h-3 w-3" />
                外部已修改
              </span>
            </TooltipTrigger>
            <TooltipContent>
              该文件在你编辑期间被外部修改。继续保存将覆盖外部版本。
            </TooltipContent>
          </Tooltip>
        )}

        {session.saveError && (
          <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[11px] text-destructive">
            保存失败：{session.saveError}
          </span>
        )}

        <span className="ml-auto truncate text-[11px] text-muted-foreground/70">
          {session.path}
        </span>

        {session.saving ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : session.dirty ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 text-sm leading-none text-[var(--rp-gold)]">●</span>
            </TooltipTrigger>
            <TooltipContent>未保存（Ctrl+S 保存）</TooltipContent>
          </Tooltip>
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={() => editorStore.toggleMode()}
            >
              {session.mode === 'wysiwyg' ? (
                <Code2 className="!size-3.5" />
              ) : (
                <Eye className="!size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {session.mode === 'wysiwyg' ? '源码模式（逃生舱）' : '返回所见即所得'}
          </TooltipContent>
        </Tooltip>
      </div>

      <FieldInput
        value={title}
        placeholder={session.path.split('/').pop()?.replace(/\.md$/i, '') ?? ''}
        disabled={!fmEditable}
        onCommit={(v) => void editorStore.setFrontmatterField('title', v)}
        className="mt-1 w-full px-1 text-lg font-semibold"
      />
    </div>
  );
}

/** Structurally broken = has an opening fence but no closing one, or the
 *  block failed YAML earlier (we can't know here, so structure only). */
function looksBroken(fmBlock: string): boolean {
  if (fmBlock === '') return false;
  const lines = fmBlock.split(/\r?\n/);
  return !lines.slice(1).some((l) => l === '---');
}
