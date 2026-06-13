/**
 * One status badge — renders the frontmatter `status:` string VERBATIM
 * (存盘值即显示值: no mapping layer), styled by the configurable status →
 * template table. Unmapped strings fall back to the gray default template —
 * a soft value written by hand stays legal, it just renders plain.
 */
import { Badge } from '@renderer/components/ui/badge';
import { templateFor, useStyleMaps } from '@renderer/stores/styles-store';

export function StatusBadge({
  value,
  size = 'md',
  chevron = false,
  className,
}: {
  value: string;
  /** md = panel/header cells; sm = the compact left-rail badge. */
  size?: 'md' | 'sm';
  /** Show the dropdown affordance (when wrapped in a menu trigger). */
  chevron?: boolean;
  className?: string | undefined;
}): JSX.Element {
  const { maps } = useStyleMaps();
  return (
    <Badge
      template={templateFor(maps, 'status', value)}
      text={value}
      size={size}
      chevron={chevron}
      className={className}
    />
  );
}
