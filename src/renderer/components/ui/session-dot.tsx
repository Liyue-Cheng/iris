/**
 * Session status light — the ONE renderer-wide indicator for a doc's session
 * activity. Round-4 D1: the left pane and the right banner used to each draw
 * their own dot with mismatched sizes and mixed glyphs (●◐○). Unify into a
 * single fixed-size colored disc; color alone carries the state:
 *   蓝 (foam) 工作中 · 黄 (gold) 空闲/等输入 · 灰 已退出.
 * A null state renders an empty fixed-width slot so rows stay aligned.
 */
import type { SessionState } from '@shared/types';
import { cn } from '@renderer/lib/utils';

const DOT: Record<SessionState, { cls: string; label: string }> = {
  active: { cls: 'bg-[var(--rp-foam)]', label: '工作中' },
  idle: { cls: 'bg-[var(--rp-gold)]', label: '空闲/等输入' },
  exited: { cls: 'bg-muted-foreground/50', label: '已退出' },
};

export function SessionDot({
  state,
  className,
}: {
  state: SessionState | null;
  className?: string;
}): JSX.Element {
  return (
    <span className={cn('flex w-3 shrink-0 items-center justify-center', className)}>
      {state && (
        <span
          className={cn('size-2 rounded-full', DOT[state].cls)}
          title={DOT[state].label}
        />
      )}
    </span>
  );
}
