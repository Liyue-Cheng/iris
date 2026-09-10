/**
 * Paging state for one background task's log view.
 *
 * The source of truth is an append-only file on disk, so the view cannot ask
 * for "everything" the way a terminal mirror can. It works on a byte window:
 *
 * - open: read the newest window (`maxBytes`, no cursor), which is the floor;
 * - while running: continue from `cursor`, appending only new bytes;
 * - "load older": double the window and re-read it as a whole, because xterm
 *   cannot prepend history into a screen it already painted.
 *
 * Everything here is pure: the dialog owns the xterm and the polling, this
 * module only decides what the next request is and what a page means.
 */
import type { IrisAgentTaskLog } from '@shared/types';

/** First screen: enough to cover a build's tail without a visible stall. */
export const TASK_LOG_INITIAL_BYTES = 256 * 1024;
/** Ceiling for re-reading history; past this we point at the file manager. */
export const TASK_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** Above this the dialog stops trying to render the log as a whole. */
export const TASK_LOG_DEGRADE_BYTES = 8 * 1024 * 1024;
export const TASK_LOG_POLL_MS = 1000;

export interface TaskLogState {
  /** `tail` re-reads the newest window; `incremental` appends from `cursor`. */
  mode: 'tail' | 'incremental';
  /** Bytes the view is currently showing; replayed whole when history grows. */
  text: string;
  /** Byte offset to resume from; null only while a tail read is pending. */
  cursor: number | null;
  /** Current window size, doubled by `expandTaskLogHistory`. */
  maxBytes: number;
  /** Bytes exist before the window. */
  hasOlder: boolean;
  /** Log bytes that existed at the last read. */
  totalBytes: number;
  /** Bytes exist outside the window (older prefix or newer tail). */
  truncated: boolean;
}

export interface TaskLogFetch {
  cursor?: number;
  maxBytes: number;
}

export function createTaskLogState(task: { outputBytes: number }): TaskLogState {
  return {
    mode: 'tail',
    text: '',
    cursor: null,
    maxBytes: TASK_LOG_INITIAL_BYTES,
    hasOlder: false,
    totalBytes: task.outputBytes,
    truncated: task.outputBytes > TASK_LOG_INITIAL_BYTES,
  };
}

/** The one request shape the dialog needs, so cursor/mode can never diverge. */
export function taskLogFetch(state: TaskLogState): TaskLogFetch {
  if (state.mode === 'incremental' && state.cursor !== null) {
    return { cursor: state.cursor, maxBytes: state.maxBytes };
  }
  return { maxBytes: state.maxBytes };
}

/**
 * Fold one page in. `reset` tells the caller to clear the xterm first: a tail
 * page replaces the buffer, an incremental page only extends it.
 *
 * A truncated incremental page means the task wrote more than a window since
 * the last poll; the next fetch falls back to a tail read to re-anchor at the
 * live end instead of grinding through a backlog the user cannot see.
 */
export function applyTaskLogPage(
  state: TaskLogState,
  page: IrisAgentTaskLog,
): { state: TaskLogState; reset: boolean } {
  const reset = state.mode === 'tail';
  const mode = !reset && page.truncated ? 'tail' : 'incremental';
  return {
    reset,
    state: {
      mode,
      text: reset ? page.data : state.text + page.data,
      cursor: page.nextCursor,
      maxBytes: state.maxBytes,
      hasOlder: reset ? page.hasOlder : state.hasOlder || page.hasOlder,
      totalBytes: page.outputBytes,
      truncated: reset ? page.hasOlder : state.hasOlder || page.hasOlder,
    },
  };
}

/** A log this large is not rendered as a whole; only its tail is offered. */
export function taskLogDegraded(state: TaskLogState): boolean {
  return state.totalBytes > TASK_LOG_DEGRADE_BYTES;
}

export function canExpandTaskLogHistory(state: TaskLogState): boolean {
  return state.hasOlder && state.maxBytes < TASK_LOG_MAX_BYTES && !taskLogDegraded(state);
}

/** Widen the window; the caller must re-fetch, and that page will reset. */
export function expandTaskLogHistory(state: TaskLogState): TaskLogState {
  if (!canExpandTaskLogHistory(state)) return state;
  return {
    ...state,
    mode: 'tail',
    maxBytes: Math.min(state.maxBytes * 2, TASK_LOG_MAX_BYTES),
  };
}

/** True when older bytes exist but the window can no longer grow to reach them. */
export function taskLogHistoryExhausted(state: TaskLogState): boolean {
  return state.hasOlder && !canExpandTaskLogHistory(state);
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
