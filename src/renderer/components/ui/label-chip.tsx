/**
 * One label chip. Labels are a soft vocabulary, so their dot color is derived
 * from the label text and stays stable without persisted configuration.
 */
import { Badge } from '@renderer/components/ui/badge';
import { labelColor } from '@renderer/lib/label-utils';

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
  const badge = (
    <Badge
      template={{ variant: 'dot', color: labelColor(label) }}
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
