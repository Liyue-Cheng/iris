/**
 * Single source for how an Agent card state reads: the label and the tone that
 * goes with it.
 *
 * Four places used to spell this out independently (the card header icon, the
 * terminal state dot, the compact group row icon, and the operations card
 * summary), so `partial` and `unchanged` had no branch at all in one of them
 * and silently rendered as "成功". Here every state is covered once, and the
 * call sites are left with nothing but the glyph choice for their own context.
 */
import type { IrisAgentCardState } from '@shared/types';

export type AgentCardStateTone = 'running' | 'success' | 'warning' | 'failure' | 'neutral';

/** `canceled` is the retrieval-item spelling of a stopped operation. */
export type AgentCardStateLike = IrisAgentCardState | 'canceled';

export function agentCardStateLabel(state: AgentCardStateLike): string {
  switch (state) {
    case 'running':
      return '运行中';
    case 'completed':
      return '成功';
    case 'failed':
      return '失败';
    case 'partial':
      return '部分失败';
    case 'stopped':
    case 'canceled':
      return '已停止';
    case 'unchanged':
      return '无变化';
  }
}

export function agentCardStateTone(state: AgentCardStateLike): AgentCardStateTone {
  switch (state) {
    case 'running':
      return 'running';
    case 'completed':
    case 'unchanged':
      return 'success';
    case 'partial':
      return 'warning';
    case 'failed':
      return 'failure';
    case 'stopped':
    case 'canceled':
      return 'neutral';
  }
}

/**
 * Icon colour for a state. `running` deliberately has no class: live states are
 * painted with the card accent variable, which the card itself owns.
 */
export function cardStateTextClass(tone: AgentCardStateTone): string {
  switch (tone) {
    case 'running':
      return '';
    case 'success':
      return 'text-emerald-500';
    case 'warning':
      return 'text-amber-500';
    case 'failure':
      return 'text-destructive';
    case 'neutral':
      return 'text-muted-foreground';
  }
}

/** Same split for the small status dots; `running` again keeps the accent. */
export function cardStateDotClass(tone: AgentCardStateTone): string {
  switch (tone) {
    case 'running':
      return '';
    case 'success':
      return 'bg-emerald-500';
    case 'warning':
      return 'bg-amber-500';
    case 'failure':
      return 'bg-destructive';
    case 'neutral':
      return 'bg-muted-foreground';
  }
}
