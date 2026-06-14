/**
 * The "显示" (Display) popover — Linear's display-options menu. Choose how the
 * list is grouped, sorted and ordered. State is owned by the caller (persisted
 * via view-prefs); this is a pure controlled menu.
 */
import { SlidersHorizontal, Check } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';

export type GroupBy = 'status' | 'workspace' | 'label' | 'none';
export type SortBy = 'date' | 'title' | 'status';
export type Order = 'asc' | 'desc';

const GROUP_LABEL: Record<GroupBy, string> = {
  status: '状态',
  workspace: '工作区',
  label: '标签',
  none: '不分组',
};

const SORT_LABEL: Record<SortBy, string> = {
  date: '日期',
  title: '标题',
  status: '状态',
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
  groupOptions = ['status', 'workspace', 'label', 'none'],
  onChange,
}: {
  groupBy: GroupBy;
  sortBy: SortBy;
  order: Order;
  groupOptions?: GroupBy[];
  onChange: (patch: { groupBy?: GroupBy; sortBy?: SortBy; order?: Order }) => void;
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs">
          <SlidersHorizontal className="h-3.5 w-3.5" /> 显示
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">分组</DropdownMenuLabel>
        {groupOptions.map((g) => (
          <Row
            key={g}
            active={groupBy === g}
            label={GROUP_LABEL[g]}
            onClick={() => onChange({ groupBy: g })}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">排序</DropdownMenuLabel>
        {(Object.keys(SORT_LABEL) as SortBy[]).map((s) => (
          <Row
            key={s}
            active={sortBy === s}
            label={SORT_LABEL[s]}
            onClick={() => onChange({ sortBy: s })}
          />
        ))}
        <DropdownMenuSeparator />
        <Row
          active={order === 'desc'}
          label="降序"
          onClick={() => onChange({ order: 'desc' })}
        />
        <Row active={order === 'asc'} label="升序" onClick={() => onChange({ order: 'asc' })} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
