/**
 * A compact badge primitive with four visual variants:
 *   solid   — filled pill, base-colored text (strong emphasis: Done / urgent)
 *   soft    — tinted pill + leading dot (the workhorse status look)
 *   outline — hairline ring, transparent fill (muted / not-started)
 *   dot     — colored dot + plain text, no fill
 *
 * Color comes through CSS vars by inline style so palette and product-level
 * semantic tones work without dynamic Tailwind classes.
 */
import { ChevronDown } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

export type BadgeVariant = 'solid' | 'soft' | 'outline' | 'dot';
export type BadgeColor =
  | 'gray'
  | 'love'
  | 'gold'
  | 'rose'
  | 'pine'
  | 'foam'
  | 'iris'
  | 'status-neutral'
  | 'status-progress'
  | 'status-review'
  | 'status-blocked'
  | 'status-hold'
  | 'status-done';

export interface BadgeTemplate {
  variant: BadgeVariant;
  color: BadgeColor;
}

export function colorVar(color: BadgeColor): string {
  if (color.startsWith('status-')) return `var(--${color})`;
  return color === 'gray' ? 'var(--rp-muted)' : `var(--rp-${color})`;
}

function hasDot(t: BadgeTemplate): boolean {
  return t.variant === 'soft' || t.variant === 'dot' || t.variant === 'outline';
}

export function Badge({
  template,
  text,
  size = 'md',
  chevron = false,
  className,
}: {
  template: BadgeTemplate;
  text: string;
  size?: 'md' | 'sm';
  /** Dropdown affordance (when wrapped in a menu trigger). */
  chevron?: boolean;
  className?: string | undefined;
}): JSX.Element {
  return (
    <span
      className={cn(
        'iris-badge inline-flex min-w-0 max-w-44 items-center gap-1 overflow-hidden rounded-full font-medium leading-none',
        size === 'md' ? 'h-[22px] px-2 text-xs' : 'h-[19px] px-1.5 text-[11px]',
        className,
      )}
      data-variant={template.variant}
      style={{ '--badge-color': colorVar(template.color) } as React.CSSProperties}
    >
      {hasDot(template) && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: colorVar(template.color) }}
        />
      )}
      <span className="min-w-0 truncate" title={text}>{text}</span>
      {chevron && <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-60" />}
    </span>
  );
}
