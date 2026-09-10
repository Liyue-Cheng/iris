import { describe, expect, it } from 'vitest';
import type { IrisAgentTaskStatus, IrisAgentTerminalView } from '@shared/types';
import {
  isActiveTaskStatus,
  statusBadgeClass,
  statusDotClass,
  taskStatusLabel,
  taskStatusTone,
  terminalStatusLabel,
  terminalStatusTone,
} from './agent-status';

function terminal(overrides: Partial<IrisAgentTerminalView>): IrisAgentTerminalView {
  return {
    id: 'terminal-1',
    toolActivityId: 'tool-1',
    command: 'npm run dev',
    cwd: '.',
    revealed: true,
    state: 'exited',
    startedAt: 1,
    userInput: false,
    ...overrides,
  };
}

describe('agent status vocabulary', () => {
  it('labels every task status and marks only live ones as active', () => {
    const statuses: IrisAgentTaskStatus[] = [
      'queued', 'starting', 'running', 'succeeded', 'failed', 'canceled', 'lost',
    ];
    expect(statuses.map(taskStatusLabel)).toEqual([
      '排队中', '启动中', '运行中', '已完成', '失败', '已取消', '已丢失',
    ]);
    expect(statuses.filter(isActiveTaskStatus)).toEqual(['queued', 'starting', 'running']);
    expect(statuses.map(taskStatusTone)).toEqual([
      'running', 'running', 'running', 'success', 'failure', 'neutral', 'failure',
    ]);
  });

  it('derives a terminal label and tone from the exit facts, not the string form', () => {
    expect(terminalStatusLabel(terminal({ state: 'running' }))).toBe('运行中');
    expect(terminalStatusLabel(terminal({ outcome: 'timeout', exitCode: null }))).toBe('已超时');
    expect(terminalStatusLabel(terminal({ outcome: 'canceled' }))).toBe('已取消');
    expect(terminalStatusLabel(terminal({ outcome: 'launch-failed' }))).toBe('启动失败');
    expect(terminalStatusLabel(terminal({}))).toBe('已结束');
    expect(terminalStatusLabel(terminal({ exitCode: 0 }))).toBe('退出码 0');
    expect(terminalStatusLabel(terminal({ exitCode: 2 }))).toBe('退出码 2');

    expect(terminalStatusTone(terminal({ state: 'running' }))).toBe('running');
    expect(terminalStatusTone(terminal({ outcome: 'timeout' }))).toBe('failure');
    expect(terminalStatusTone(terminal({ outcome: 'launch-failed' }))).toBe('failure');
    expect(terminalStatusTone(terminal({ outcome: 'canceled' }))).toBe('neutral');
    expect(terminalStatusTone(terminal({}))).toBe('neutral');
    expect(terminalStatusTone(terminal({ exitCode: 0 }))).toBe('success');
    expect(terminalStatusTone(terminal({ exitCode: 1 }))).toBe('failure');
  });

  it('maps every tone to a badge and a dot class', () => {
    expect(statusBadgeClass('running')).toBe(statusBadgeClass('success'));
    expect(statusBadgeClass('failure')).toContain('destructive');
    expect(statusDotClass('neutral')).toBe('bg-muted-foreground');
    expect(statusDotClass('failure')).toBe('bg-destructive');
  });
});
