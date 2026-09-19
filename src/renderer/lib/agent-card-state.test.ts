import { describe, expect, it } from 'vitest';
import type { IrisAgentCardState } from '@shared/types';
import {
  agentCardStateLabel,
  agentCardStateTone,
  cardStateDotClass,
  cardStateTextClass,
  type AgentCardStateTone,
} from './agent-card-state';

const STATES: IrisAgentCardState[] = [
  'running', 'completed', 'failed', 'partial', 'stopped', 'unchanged',
];

describe('agent card state vocabulary', () => {
  it('labels every card state, with no silent fallthrough', () => {
    expect(STATES.map(agentCardStateLabel)).toEqual([
      '运行中', '成功', '失败', '部分失败', '已停止', '无变化',
    ]);
    expect(agentCardStateLabel('canceled')).toBe('已停止');
  });

  it('gives every card state a tone', () => {
    expect(STATES.map(agentCardStateTone)).toEqual([
      'running', 'success', 'failure', 'warning', 'neutral', 'success',
    ]);
    expect(agentCardStateTone('canceled')).toBe('neutral');
  });

  it('maps every tone to a text and a dot class, leaving running to the accent', () => {
    const tones: AgentCardStateTone[] = ['running', 'success', 'warning', 'failure', 'neutral'];
    expect(tones.map(cardStateTextClass)).toEqual([
      '', 'text-emerald-500', 'text-amber-500', 'text-destructive', 'text-muted-foreground',
    ]);
    expect(tones.map(cardStateDotClass)).toEqual([
      '', 'bg-emerald-500', 'bg-amber-500', 'bg-destructive', 'bg-muted-foreground',
    ]);
  });
});
