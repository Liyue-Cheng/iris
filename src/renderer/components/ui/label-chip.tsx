/**
 * One label chip — Linear-style colored dot + name. Color is the
 * deterministic name hash from label-utils (no stored color, no registry).
 */
import { X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { labelColorVar } from '@renderer/lib/label-utils';

export function LabelChip({
  label,
  onClick,
  onRemove,
  className,
}: {
  label: string;
  onClick?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  className?: string | undefined;
}): JSX.Element {
  const colorVar = labelColorVar(label);
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      {...(onClick
        ? {
            type: 'button' as const,
            // chips sit inside clickable rows — don't also fire the row
            onClick: (e: React.MouseEvent) => {
              e.stopPropagation();
              onClick();
            },
          }
        : {})}
      className={cn(
        'inline-flex max-w-36 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-1.5 py-px text-[10px] leading-4 text-muted-foreground',
        onClick && 'hover:border-border hover:text-foreground',
        className,
      )}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: `var(${colorVar})` }}
      />
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          title={`移除标签 ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-0.5 rounded-full p-px hover:bg-muted hover:text-foreground"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </Tag>
  );
}
