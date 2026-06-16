/**
 * The typed header — sole owner of the frontmatter UI (the body editor
 * never sees it). Two fixed rows (E-3 布局拍板):
 *   row 1 — title · status badge · save indicator · code button. The whole
 *           header lives in the SAME column as the Crepe body — a 48rem box
 *           inside the px-2.5 scrollbar gutter — so the title's left edge AND
 *           the right-hand controls' right edge line up with the body text at
 *           every pane width. The column centers or left-hugs per
 *           behavior.editorBodyAlign (mirroring the body). The status badge
 *           sits AFTER the title. The doc path is NOT resident: it shows in a
 *           tooltip when hovering the title. No type badge (the lens already
 *           told you the type).
 *   row 2 — priority + labels (issue only), in the same column.
 * Row 1 is h-11 to line up with the left/right pane headers (三栏第一行对齐).
 *
 * `status:` is a SOFT value: the menu shows the canonical state machine for
 * the doc's type (issues six states, reports two) PLUS a free-text input —
 * 键是硬的，值是软的. The stored value is the displayed value; the badge
 * styles come from the configurable status → style table.
 */
import { useEffect, useState } from 'react';
import {
  Check,
  Code2,
  Eye,
  FileWarning,
  Loader2,
  Pencil,
  Plus,
  Tag,
  TriangleAlert,
} from 'lucide-react';
import type { DocType } from '@shared/types';
import { ISSUE_STATUSES, REPORT_STATUSES } from '@shared/style-maps';
import { parseYamlFlowSeq, yamlFlowSeq } from '@shared/markdown-utils';
import { cn } from '@renderer/lib/utils';
import { editorStore, type EditorSession } from '@renderer/stores/editor-store';
import { useProject } from '@renderer/stores/project-store';
import { useSettings } from '@renderer/stores/settings-store';
import { collectAllLabels } from '@renderer/lib/label-utils';
import { LabelChip } from '@renderer/components/ui/label-chip';
import { StatusBadge } from '@renderer/components/ui/status-badge';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';

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
}: {
  value: string;
  placeholder: string;
  disabled: boolean;
  onCommit: (v: string) => void;
  className?: string;
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

/**
 * Status editor — the badge is the trigger; the menu shows the full
 * canonical set for this doc type plus a free-value input (soft values
 * stay first-class, they just render gray until mapped in the table).
 */
function StatusEditor({
  type,
  value,
  disabled,
}: {
  type: DocType | null;
  value: string;
  disabled: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const options: readonly string[] = type === 'report' ? REPORT_STATUSES : ISSUE_STATUSES;

  const set = (v: string): void => {
    const trimmed = v.trim();
    if (trimmed !== '' && trimmed !== value) {
      void editorStore.setFrontmatterField('status', trimmed);
    }
    setDraft('');
    setOpen(false);
  };

  const badge = (
    <StatusBadge value={value === '' ? '—' : value} chevron={!disabled} />
  );
  if (disabled) return badge;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" title="状态">
          {badge}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((s) => (
          <DropdownMenuItem key={s} onClick={() => set(s)}>
            <StatusBadge value={s} />
          </DropdownMenuItem>
        ))}
        <input
          value={draft}
          placeholder="自由值，回车写入"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation(); // keep Radix typeahead out of the input
            if (e.key === 'Enter') set(draft);
          }}
          className="mx-1 my-0.5 w-36 rounded-sm bg-muted/60 px-1.5 py-0.5 text-xs outline-none"
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Label editor — chips plus an add menu whose suggestions are the
 * project-wide union of labels in use (no registry; see label-utils).
 * Writes `labels:` as a single-line YAML flow sequence so the frontmatter
 * line surgery applies.
 */
function LabelsEditor({ disabled }: { disabled: boolean }): JSX.Element {
  const { scan } = useProject();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const labels = parseYamlFlowSeq(editorStore.getFrontmatterField('labels') ?? '');
  const candidates = (scan?.root ? collectAllLabels(scan.root) : []).filter(
    (l) => !labels.includes(l),
  );

  const write = (next: string[]): void => {
    void editorStore.setFrontmatterFieldRaw('labels', yamlFlowSeq(next));
  };
  const add = (label: string): void => {
    const v = label.trim();
    if (v !== '' && !labels.includes(v)) write([...labels, v]);
    setDraft('');
    setOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Tag className="h-3 w-3 text-muted-foreground/60" />
      {labels.map((l) => (
        <LabelChip
          key={l}
          label={l}
          onRemove={disabled ? undefined : () => write(labels.filter((x) => x !== l))}
        />
      ))}
      {labels.length === 0 && (
        <span className="text-[11px] text-muted-foreground/50">无标签</span>
      )}
      {!disabled && (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="添加标签"
              className="rounded-full border border-subtle p-0.5 text-muted-foreground hover:border-border hover:text-foreground"
            >
              <Plus className="h-2.5 w-2.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <input
              autoFocus
              value={draft}
              placeholder="新标签，回车添加"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation(); // keep Radix typeahead out of the input
                if (e.key === 'Enter') add(draft);
              }}
              className="mx-1 my-0.5 w-36 rounded-sm bg-muted/60 px-1.5 py-0.5 text-xs outline-none"
            />
            {candidates.map((c) => (
              <DropdownMenuItem key={c} onClick={() => add(c)}>
                <LabelChip label={c} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function TypedHeader({ session }: { session: EditorSession }): JSX.Element {
  const type = typeOfPath(session.path);
  const title = editorStore.getFrontmatterField('title') ?? '';
  const status = editorStore.getFrontmatterField('status') ?? '';
  // A structurally broken frontmatter block is shown, never auto-edited.
  const fmEditable = !looksBroken(session.fmBlock);

  // px-2.5 = the body's reserved 10px scrollbar gutter; the inner column is
  // the body's 48rem reading column (mx-auto centered / mr-auto left-hugged
  // per the setting). Title left + controls right then track the body text.
  const bodyAlign = useSettings()?.behavior.editorBodyAlign ?? 'center';
  const column = cn('max-w-3xl px-6', bodyAlign === 'left' ? 'mr-auto' : 'mx-auto');

  return (
    <div className="shrink-0 bg-card/30 px-2.5">
      <div className={column}>
        {/* Row 1 — h-11, aligned with the left/right pane headers. */}
        <div className="flex h-11 items-center gap-2">
          <Tooltip>
            {/* span wrapper: FieldInput doesn't forward refs, Radix asChild needs one.
                -ml-1.5 cancels the input's px-1.5 so the title glyph is flush at the
                column's left edge (= body text), while the hover bg keeps its inset. */}
            <TooltipTrigger asChild>
              <span className="-ml-1.5 flex min-w-0 flex-1">
                <FieldInput
                  value={title}
                  placeholder={session.path.split('/').pop()?.replace(/\.md$/i, '') ?? ''}
                  disabled={!fmEditable}
                  onCommit={(v) => void editorStore.setFrontmatterField('title', v)}
                  className="min-w-0 flex-1 px-1.5 text-lg font-semibold"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>{session.path}</TooltipContent>
          </Tooltip>

          <StatusEditor type={type} value={status} disabled={!fmEditable} />

          {!fmEditable && (
            <span className="flex shrink-0 items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 text-xs text-destructive">
              <FileWarning className="h-3 w-3" />
              frontmatter 异常 — 字段编辑已禁用，可用源码模式修复
            </span>
          )}

          {session.externalConflict && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex shrink-0 items-center gap-1 rounded bg-[var(--rp-gold)]/20 px-1.5 py-0.5 text-xs text-[var(--rp-gold)]">
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
            <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-xs text-destructive">
              保存失败：{session.saveError}
            </span>
          )}

          {session.saving ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : session.dirty ? (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* D2: pencil, not a gold dot — the gold dot collided with the
                    terminal's idle light. A monochrome glyph reads as "edited". */}
                <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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

        {/* Row 2 — labels (issue only), in the same column. */}
        {type === 'issue' && (
          <div className="flex items-center gap-2 pb-1.5">
            <LabelsEditor disabled={!fmEditable} />
          </div>
        )}
      </div>
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
