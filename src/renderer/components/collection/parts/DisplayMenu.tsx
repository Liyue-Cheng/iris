/**
 * The "显示" (Display) popover — Linear's display-options menu. Choose how the
 * list is grouped, sorted and ordered. State is owned by the caller (persisted
 * via view-prefs); this is a pure controlled menu.
 */
import { SlidersHorizontal, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';

export type GroupBy = 'status' | 'workspace' | 'none';
export type SortBy = 'date' | 'title' | 'status';
export type Order = 'asc' | 'desc';

const GROUP_LABEL: Record<GroupBy, 'collection.status' | 'collection.workspace' | 'collection.noGrouping'> = {
  status: 'collection.status',
  workspace: 'collection.workspace',
  none: 'collection.noGrouping',
};

const SORT_LABEL: Record<SortBy, 'collection.date' | 'collection.title' | 'collection.status'> = {
  date: 'collection.date',
  title: 'collection.title',
  status: 'collection.status',
};

function Row({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <DropdownMenuItem onClick={onClick} className="justify-between gap-6">
      <span>{label}</span>
      {active && <Check className="h-3.5 w-3.5" />}
    </DropdownMenuItem>
  );
}

export function DisplayMenu({
  groupBy,
  sortBy,
  order,
  groupOptions = ['status', 'workspace', 'none'],
  onChange,
}: {
  groupBy: GroupBy;
  sortBy: SortBy;
  order: Order;
  groupOptions?: GroupBy[];
  onChange: (patch: { groupBy?: GroupBy; sortBy?: SortBy; order?: Order }) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs">
          <SlidersHorizontal className="h-3.5 w-3.5" /> {t('collection.display')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">{t('collection.group')}</DropdownMenuLabel>
        {groupOptions.map((g) => (
          <Row
            key={g}
            active={groupBy === g}
            label={t(GROUP_LABEL[g])}
            onClick={() => onChange({ groupBy: g })}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">{t('collection.sort')}</DropdownMenuLabel>
        {(Object.keys(SORT_LABEL) as SortBy[]).map((s) => (
          <Row
            key={s}
            active={sortBy === s}
            label={t(SORT_LABEL[s])}
            onClick={() => onChange({ sortBy: s })}
          />
        ))}
        <DropdownMenuSeparator />
        <Row
          active={order === 'desc'}
          label={t('collection.descending')}
          onClick={() => onChange({ order: 'desc' })}
        />
        <Row active={order === 'asc'} label={t('collection.ascending')} onClick={() => onChange({ order: 'asc' })} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
