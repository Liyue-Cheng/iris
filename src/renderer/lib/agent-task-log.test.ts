import { describe, expect, it } from 'vitest';
import type { IrisAgentTaskLog } from '@shared/types';
import {
  TASK_LOG_DEGRADE_BYTES,
  TASK_LOG_INITIAL_BYTES,
  TASK_LOG_MAX_BYTES,
  applyTaskLogPage,
  canExpandTaskLogHistory,
  createTaskLogState,
  expandTaskLogHistory,
  formatByteSize,
  taskLogDegraded,
  taskLogFetch,
  taskLogHistoryExhausted,
  type TaskLogState,
} from './agent-task-log';

function page(overrides: Partial<IrisAgentTaskLog>): IrisAgentTaskLog {
  return {
    task: {
      taskId: 'task-1', sessionId: 'session-1', intentId: 'intent-1', title: 'Dev server',
      command: 'npm run dev', cwd: '.', status: 'running', createdAt: 1, outputBytes: 0,
    },
    data: '',
    nextCursor: 0,
    hasOlder: false,
    outputBytes: 0,
    truncated: false,
    ...overrides,
  };
}

function fold(state: TaskLogState, ...pages: IrisAgentTaskLog[]): TaskLogState {
  return pages.reduce((current, next) => applyTaskLogPage(current, next).state, state);
}

describe('task log paging', () => {
  it('opens with a tail read and then polls from the reported byte offset', () => {
    const state = createTaskLogState({ outputBytes: 12 });
    expect(taskLogFetch(state)).toEqual({ maxBytes: TASK_LOG_INITIAL_BYTES });

    const first = applyTaskLogPage(state, page({
      data: 'tail', nextCursor: 12, hasOlder: true, outputBytes: 12, truncated: true,
    }));
    expect(first.reset).toBe(true);
    expect(first.state.text).toBe('tail');
    expect(first.state.hasOlder).toBe(true);
    expect(taskLogFetch(first.state)).toEqual({ cursor: 12, maxBytes: TASK_LOG_INITIAL_BYTES });

    const appended = applyTaskLogPage(first.state, page({
      data: '+more', nextCursor: 17, hasOlder: true, outputBytes: 17, truncated: true,
    }));
    expect(appended.reset).toBe(false);
    expect(appended.state.text).toBe('tail+more');
    expect(appended.state.hasOlder).toBe(true);
  });

  it('falls back to a tail re-read when a poll returns a truncated page', () => {
    const state = fold(
      createTaskLogState({ outputBytes: 0 }),
      page({ data: 'start', nextCursor: 5, outputBytes: 5 }),
    );
    expect(state.mode).toBe('incremental');

    // The task wrote more than one window while the dialog was between polls:
    // the next fetch re-anchors at the live end instead of grinding a backlog.
    const burst = applyTaskLogPage(state, page({
      data: 'window', nextCursor: 11, outputBytes: 999_999, truncated: true,
    }));
    expect(burst.reset).toBe(false);
    expect(burst.state.mode).toBe('tail');
    expect(taskLogFetch(burst.state)).toEqual({ maxBytes: TASK_LOG_INITIAL_BYTES });

    const reanchored = applyTaskLogPage(burst.state, page({
      data: 'live end', nextCursor: 999_999, hasOlder: true, outputBytes: 999_999, truncated: true,
    }));
    expect(reanchored.reset).toBe(true);
    expect(reanchored.state.text).toBe('live end');
  });

  it('doubles the window to reach older history and stops at the ceiling', () => {
    let state = fold(
      createTaskLogState({ outputBytes: 5_000_000 }),
      page({ data: 'window', nextCursor: 5_000_000, hasOlder: true, outputBytes: 5_000_000, truncated: true }),
    );
    expect(canExpandTaskLogHistory(state)).toBe(true);

    state = expandTaskLogHistory(state);
    expect(state.maxBytes).toBe(TASK_LOG_INITIAL_BYTES * 2);
    expect(state.mode).toBe('tail');
    expect(taskLogFetch(state)).toEqual({ maxBytes: TASK_LOG_INITIAL_BYTES * 2 });

    while (state.maxBytes < TASK_LOG_MAX_BYTES) state = expandTaskLogHistory(state);
    expect(state.maxBytes).toBe(TASK_LOG_MAX_BYTES);
    const atCeiling = expandTaskLogHistory(state);
    expect(atCeiling).toBe(state);
    expect(canExpandTaskLogHistory(atCeiling)).toBe(false);
    expect(taskLogHistoryExhausted(atCeiling)).toBe(true);
  });

  it('degrades instead of expanding once the log is too large to render', () => {
    const state = fold(
      createTaskLogState({ outputBytes: 0 }),
      page({
        data: 'window',
        nextCursor: TASK_LOG_DEGRADE_BYTES + 1,
        hasOlder: true,
        outputBytes: TASK_LOG_DEGRADE_BYTES + 1,
        truncated: true,
      }),
    );
    expect(taskLogDegraded(state)).toBe(true);
    expect(canExpandTaskLogHistory(state)).toBe(false);
    expect(expandTaskLogHistory(state)).toBe(state);
    expect(taskLogHistoryExhausted(state)).toBe(true);
  });

  it('offers no history for a log that fits in the first window', () => {
    const state = fold(
      createTaskLogState({ outputBytes: 0 }),
      page({ data: 'all of it', nextCursor: 9, outputBytes: 9 }),
    );
    expect(state.hasOlder).toBe(false);
    expect(state.truncated).toBe(false);
    expect(canExpandTaskLogHistory(state)).toBe(false);
    expect(taskLogHistoryExhausted(state)).toBe(false);
  });

  it('formats byte sizes for the header and the footer', () => {
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(2048)).toBe('2 KB');
    expect(formatByteSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
