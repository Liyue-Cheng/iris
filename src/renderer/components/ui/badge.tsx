/**
 * The badge — one carefully-designed component rendering a status or label
 * per its assigned template (round-3 验收反馈: 不只是变色，是精心设计的标签
 * 组件). Four variants:
 *   solid   — filled pill, base-colored text (strong emphasis: Done / urgent)
 *   soft    — tinted pill + leading dot (the workhorse status look)
 *   outline — hairline ring, transparent fill (muted / not-started)
 *   dot     — colored dot + plain text, no fill (the classic label look)
 *
 * Color comes through CSS vars by inline style (so any of the 7 palette
 * slots works without Tailwind needing every dynamic class at build time);
 * structure/spacing is Tailwind. gray resolves to the muted tone.
 */
import { ChevronDown, X } from 'lucide-react';
import type { BadgeColor, BadgeTemplate } from '@shared/style-maps';
import { cn } from '@renderer/lib/utils';

export function colorVar(color: BadgeColor): string {
  return color === 'gray' ? 'var(--rp-muted)' : `var(--rp-${color})`;
}

/** Background/border/text styles for the pill itself (not the dot). */
function pillStyle(t: BadgeTemplate): React.CSSProperties {
  const c = colorVar(t.color);
  switch (t.variant) {
    case 'solid':
      return { backgroundColor: c, color: 'var(--rp-base)' };
    case 'soft':
      return { backgroundColor: `color-mix(in srgb, ${c} 16%, transparent)`, color: c };
    case 'outline':
      return {
        border: `1px solid color-mix(in srgb, ${c} 45%, transparent)`,
        color: c,
      };
    case 'dot':
      return {}; // plain text; color lives in the dot + inherited foreground
  }
}

function hasDot(t: BadgeTemplate): boolean {
  return t.variant === 'soft' || t.variant === 'dot' || t.variant === 'outline';
}

export function Badge({
  template,
  text,
  size = 'md',
  chevron = false,
  onRemove,
  className,
}: {
  template: BadgeTemplate;
  text: string;
  size?: 'md' | 'sm';
  /** Dropdown affordance (when wrapped in a menu trigger). */
  chevron?: boolean;
  /** Removable chip (labels). */
  onRemove?: (() => void) | undefined;
  className?: string | undefined;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex max-w-44 items-center gap-1 rounded-full font-medium leading-none',
        size === 'md' ? 'px-2 py-1 text-xs' : 'px-1.5 py-0.5 text-[11px]',
        template.variant === 'dot' && 'text-foreground/85',
        className,
      )}
      style={pillStyle(template)}
    >
      {hasDot(template) && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: colorVar(template.color) }}
        />
      )}
      <span className="truncate">{text}</span>
      {chevron && <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-60" />}
      {onRemove && (
        <button
          type="button"
          title={`移除 ${text}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-0.5 shrink-0 rounded-full p-px opacity-70 hover:bg-black/10 hover:opacity-100"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
