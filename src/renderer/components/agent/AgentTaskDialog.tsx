/**
 * Agent background task dialog — a read-only window onto one task's log file.
 *
 * A task's output truth is an append-only file on disk, not a terminal mirror,
 * so this view pages bytes instead of replaying a snapshot:
 *
 * - open: the newest window, then a one-second incremental poll while the task
 *   is active (a settled task stops polling and gets one final read);
 * - "load older" doubles the window and re-renders it whole, because xterm
 *   cannot prepend history to a screen it already painted;
 * - past the ceiling the dialog degrades to the tail and points at the file
 *   manager instead of trying to render a multi-megabyte log.
 *
 * Closing stops the polling only. It never cancels the task, never touches the
 * log, and never feeds anything back into the Agent's context.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Copy, FolderOpen, LoaderCircle, Play, Square } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import type { IrisAgentTaskView } from '@shared/types';
import {
  AgentStatusBadge,
  AgentWorkbenchDialog,
} from '@renderer/components/agent/AgentWorkbenchDialog';
import { TerminalSurface } from '@renderer/components/terminal/TerminalSurface';
import { BrowserXtermAdapter } from '@renderer/terminal/xterm-adapter';
import { Button } from '@renderer/components/ui/button';
import { cancelIrisAgentTask, readIrisAgentTaskLog } from '@renderer/lib/iris-agent-actions';
import { revealProjectItem } from '@renderer/lib/shell-actions';
import { writeClipboardText } from '@renderer/lib/clipboard';
import { getSettings, useSettings } from '@renderer/stores/settings-store';
import { isActiveTaskStatus, taskStatusLabel, taskStatusTone } from '@renderer/lib/agent-status';
import {
  TASK_LOG_DEGRADE_BYTES,
  TASK_LOG_POLL_MS,
  applyTaskLogPage,
  canExpandTaskLogHistory,
  createTaskLogState,
  expandTaskLogHistory,
  formatByteSize,
  taskLogDegraded,
  taskLogFetch,
  taskLogHistoryExhausted,
  type TaskLogState,
} from '@renderer/lib/agent-task-log';

export function AgentTaskDialog({
  sessionId,
  task,
  onClose,
}: {
  sessionId: string;
  task: IrisAgentTaskView;
  onClose: () => void;
}): JSX.Element {
  const { state, error, hostRef, expand, retry } = useTaskLog(sessionId, task);
  const active = isActiveTaskStatus(task.status);
  const [copied, setCopied] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const logRef = task.logRef;

  // The cancel button is a request, not a state change: it stays in its
  // "canceling…" form until the settled status actually arrives.
  useEffect(() => {
    if (!active) setCanceling(false);
  }, [active]);

  return (
    <AgentWorkbenchDialog
      icon={<Play className="h-4 w-4" />}
      title={task.title}
      titleLabel={task.command}
      badge={<AgentStatusBadge tone={taskStatusTone(task.status)} label={taskStatusLabel(task.status)} />}
      subtitle={
        <>
          <span className="shrink-0" aria-label={task.taskId}>
            {shortTaskId(task.taskId)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-label={copied ? '任务 ID 已复制' : '复制任务 ID'}
            onClick={() => {
              // async-boundary: handled - the clipboard helper reports failures.
              void writeClipboardText(task.taskId).then((ok) => {
                if (!ok) return;
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            <Copy className="!size-3" />
          </Button>
          <span className="truncate" aria-label={task.cwd}>{task.cwd}</span>
          <span className="shrink-0 tabular-nums" aria-label={`${task.outputBytes} bytes`}>
            {formatByteSize(state.totalBytes)}
          </span>
        </>
      }
      subtitleLabel={`${task.taskId} ${task.cwd}`}
      actions={
        <>
          {logRef && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 bg-background text-[11px]"
              onClick={() => void revealProjectItem(logRef)}
            >
              <FolderOpen className="!size-3.5" />
              显示日志文件
            </Button>
          )}
          {active && (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-7 shrink-0 text-[11px]"
              disabled={canceling}
              onClick={() => {
                setCanceling(true);
                // async-boundary: handled - the action reports its own failure,
                // and the settled status clears the pending state.
                void cancelIrisAgentTask(sessionId, task.taskId).catch(() => setCanceling(false));
              }}
            >
              {canceling
                ? <><LoaderCircle className="!size-3.5 animate-spin" />取消中…</>
                : <><Square className="!size-3" />取消任务</>}
            </Button>
          )}
        </>
      }
      bodyClassName="flex min-h-0 flex-1 flex-col"
      onClose={onClose}
    >
      <div className="relative min-h-0 flex-1 bg-background">
        <TerminalSurface hostRef={hostRef} revealed />
        {state.text === '' && !error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            {active ? '任务尚未产生输出，新输出会实时追加' : '该任务没有产生输出'}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t bg-card/50 px-4 py-1.5 text-[11px] text-muted-foreground">
        {active && (
          <span className="flex items-center gap-1.5">
            <span className="iris-agent-terminal-dot h-1.5 w-1.5 rounded-full bg-emerald-500" data-running="true" aria-hidden="true" />
            每秒增量读取
          </span>
        )}
        {canExpandTaskLogHistory(state) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={expand}
          >
            加载更早的日志（当前 {formatByteSize(state.maxBytes)}）
          </Button>
        )}
        {taskLogDegraded(state) ? (
          <span className="text-amber-600 dark:text-amber-400">
            日志 {formatByteSize(state.totalBytes)} 超过 {formatByteSize(TASK_LOG_DEGRADE_BYTES)}，
            仅显示末尾；完整日志请在文件管理器中打开
          </span>
        ) : taskLogHistoryExhausted(state) ? (
          <span className="text-amber-600 dark:text-amber-400">
            已显示最近 {formatByteSize(state.maxBytes)}，更早内容请在文件管理器中打开
          </span>
        ) : null}
        {error && (
          <span className="flex items-center gap-2 text-destructive">
            {error}
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={retry}>
              重试
            </Button>
          </span>
        )}
        {task.error && <span className="text-destructive">{task.error}</span>}
      </div>
    </AgentWorkbenchDialog>
  );
}

function shortTaskId(taskId: string): string {
  return taskId.slice(0, 8);
}

/**
 * Owns the xterm and the byte-cursor polling for one task. It is separate from
 * the header so a status or copy interaction never restarts the log view.
 */
function useTaskLog(sessionId: string, task: IrisAgentTaskView): {
  state: TaskLogState;
  error: string | null;
  hostRef: RefObject<HTMLDivElement>;
  expand: () => void;
  retry: () => void;
} {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<BrowserXtermAdapter | null>(null);
  const logRef = useRef<TaskLogState | null>(null);
  if (logRef.current === null) logRef.current = createTaskLogState(task);
  const pumpRef = useRef<(() => void) | null>(null);
  const statusRef = useRef(task.status);
  statusRef.current = task.status;
  const [state, setState] = useState<TaskLogState>(logRef.current);
  const [error, setError] = useState<string | null>(null);
  const settings = useSettings();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const current = getSettings();
    const adapter = new BrowserXtermAdapter({
      fontFamily: current?.appearance.terminalFontFamily ?? "'Cascadia Mono', 'Consolas', monospace",
      fontSize: current?.appearance.terminalFontSize ?? 13,
      lineHeight: current?.appearance.terminalLineHeight ?? 1.2,
      themeId: current?.appearance.theme,
      renderer: current?.advanced.terminalRenderer ?? 'auto',
      windowsBuild: window.api.windowsBuild,
      openLink: () => undefined,
    });
    adapterRef.current = adapter;
    adapter.open(host);
    const term = adapter.terminal;
    // Read-only: keystrokes have nowhere to go, so do not invite them.
    term.options.disableStdin = true;
    const fit = (): void => {
      try {
        adapter.fit.fit();
      } catch {
        // Layout can briefly have zero dimensions while the dialog animates in.
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    function write(data: string, reset: boolean): void {
      if (!data) return;
      if (!reset) {
        term.write(data);
        return;
      }
      // A wider window replaces the screen: clearing between synchronized
      // output markers avoids showing a half-painted log while it is rewritten.
      adapter.beginSynchronizedReplay();
      term.write(data, () => adapter.endSynchronizedReplay());
      term.scrollToBottom();
    }

    function schedule(): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(pump, TASK_LOG_POLL_MS);
    }

    function pump(): void {
      if (disposed || inFlight) return;
      inFlight = true;
      const request = readIrisAgentTaskLog(sessionId, task.taskId, taskLogFetch(logRef.current!));
      // async-boundary: handled - every failure becomes the inline error state.
      void request.then((result) => {
        if (disposed) return;
        const outcome = applyTaskLogPage(logRef.current!, result);
        logRef.current = outcome.state;
        write(result.data, outcome.reset);
        setState(outcome.state);
        setError(null);
      }).catch((failure: unknown) => {
        if (disposed) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      }).finally(() => {
        inFlight = false;
        if (!disposed && isActiveTaskStatus(statusRef.current)) schedule();
      });
    }

    pumpRef.current = pump;
    pump();
    return () => {
      disposed = true;
      pumpRef.current = null;
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
      adapter.dispose();
      adapterRef.current = null;
    };
  }, [sessionId, task.taskId]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || !settings) return;
    adapter.updateAppearance({
      themeId: settings.appearance.theme,
      fontFamily: settings.appearance.terminalFontFamily,
      fontSize: settings.appearance.terminalFontSize,
      lineHeight: settings.appearance.terminalLineHeight,
    });
    adapter.fit.fit();
  }, [settings]);

  // Polling stops with the task; one final read still has to pick up whatever
  // the last write appended, otherwise the tail of the log is missing exactly
  // when the task is done and the user looks at it.
  const active = isActiveTaskStatus(task.status);
  const wasActiveRef = useRef(active);
  useEffect(() => {
    if (wasActiveRef.current && !active) pumpRef.current?.();
    wasActiveRef.current = active;
  }, [active]);

  const expand = useCallback(() => {
    const next = expandTaskLogHistory(logRef.current!);
    if (next === logRef.current) return;
    logRef.current = next;
    setState(next);
    pumpRef.current?.();
  }, []);

  const retry = useCallback(() => {
    setError(null);
    pumpRef.current?.();
  }, []);

  return { state, error, hostRef, expand, retry };
}
