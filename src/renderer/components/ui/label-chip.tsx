/**
 * One label chip — renders the label string per its assigned template from
 * the configurable label → template table (round-3: same template system as
 * status; an unmapped label gets the gray default). Defaults lean to the
 * `dot` variant (the classic label look), but any template the user assigns
 * applies — labels and statuses share one designed component.
 */
import { Badge } from '@renderer/components/ui/badge';
import { templateFor, useStyleMaps } from '@renderer/stores/styles-store';

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
  const { maps } = useStyleMaps();
  const badge = (
    <Badge
      template={templateFor(maps, 'label', label)}
      text={label}
      size="sm"
      onRemove={onRemove}
      className={className}
    />
  );
  if (!onClick) return badge;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded-full hover:opacity-80"
    >
      {badge}
    </button>
  );
}
