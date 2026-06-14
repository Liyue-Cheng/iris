/**
 * Sticky, collapsible group header for grouped list panels. Shows a leading
 * affordance (chevron), an optional glyph, the group label and a count. Stays
 * pinned to the top of the scroll area as you scroll its section.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { GROUP_BAR } from './layout';

export function GroupHeader({
  label,
  count,
  collapsed,
  onToggle,
  glyph,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  glyph?: React.ReactNode;
}): JSX.Element {
  return (
    <button type="button" onClick={onToggle} className={cn(GROUP_BAR, 'w-full hover:bg-card/80')}>
      {collapsed ? (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
      ) : (
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
      )}
      {glyph}
      <span className="truncate font-medium text-foreground/80">{label}</span>
      <span className="shrink-0 text-muted-foreground/70">{count}</span>
    </button>
  );
}
