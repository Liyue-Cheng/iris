/**
 * One status badge — renders the frontmatter `status:` string VERBATIM
 * (stored value = displayed value). Canonical statuses use product-owned
 * visual semantics; exceptional values remain legal and render neutrally.
 */
import { ISSUE_STATUS, REPORT_STATUS } from '@shared/document-status';
import { Badge, type BadgeTemplate } from '@renderer/components/ui/badge';

const NEUTRAL_TEMPLATE: BadgeTemplate = { variant: 'soft', color: 'gray' };

const STATUS_TEMPLATES: Readonly<Record<string, BadgeTemplate>> = {
  [ISSUE_STATUS.todo]: NEUTRAL_TEMPLATE,
  [ISSUE_STATUS.inProgress]: { variant: 'soft', color: 'foam' },
  [ISSUE_STATUS.inReview]: { variant: 'soft', color: 'gold' },
  [ISSUE_STATUS.blocked]: { variant: 'soft', color: 'love' },
  [ISSUE_STATUS.onHold]: { variant: 'outline', color: 'gold' },
  [ISSUE_STATUS.done]: { variant: 'solid', color: 'pine' },
  [ISSUE_STATUS.canceled]: { variant: 'outline', color: 'gray' },
  [REPORT_STATUS.active]: { variant: 'soft', color: 'foam' },
  [REPORT_STATUS.backlog]: { variant: 'dot', color: 'gray' },
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
      className={className}
    />
  );
}
