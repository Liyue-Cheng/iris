/**
 * One status badge — renders the frontmatter `status:` string VERBATIM
 * (stored value = displayed value). Canonical statuses use product-owned
 * visual semantics; exceptional values remain legal and render neutrally.
 */
import { ISSUE_STATUS, REPORT_STATUS } from '@shared/document-status';
import { Badge, type BadgeTemplate } from '@renderer/components/ui/badge';

const NEUTRAL_TEMPLATE: BadgeTemplate = { variant: 'soft', color: 'status-neutral' };

const STATUS_TEMPLATES: Readonly<Record<string, BadgeTemplate>> = {
  [ISSUE_STATUS.todo]: { variant: 'soft', color: 'status-neutral' },
  [ISSUE_STATUS.inProgress]: { variant: 'soft', color: 'status-progress' },
  [ISSUE_STATUS.inReview]: { variant: 'soft', color: 'status-review' },
  [ISSUE_STATUS.blocked]: { variant: 'soft', color: 'status-blocked' },
  [ISSUE_STATUS.onHold]: { variant: 'soft', color: 'status-hold' },
  [ISSUE_STATUS.done]: { variant: 'soft', color: 'status-done' },
  [ISSUE_STATUS.canceled]: { variant: 'soft', color: 'status-neutral' },
  [REPORT_STATUS.active]: { variant: 'soft', color: 'status-progress' },
  [REPORT_STATUS.backlog]: { variant: 'soft', color: 'status-neutral' },
};

export function statusTemplate(value: string): BadgeTemplate {
  return STATUS_TEMPLATES[value] ?? NEUTRAL_TEMPLATE;
}

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
  return (
    <Badge
      template={statusTemplate(value)}
      text={value}
      size={size}
      chevron={chevron}
      className={`iris-status-badge${className ? ` ${className}` : ''}`}
    />
  );
}
