import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  AgentToolOperationResult,
} from '@shared/agent-protocol';
import { writeFileAtomic } from '../atomic-write';
import {
  AgentCommandPty,
  type AgentCommandPtyOptions,
} from './command-pty';
import { defaultProcessTreeKiller } from '../terminal/process-tree';
import type { AgentTaskSummary } from './session-model';
import type { AgentCommandShell } from '@shared/agent-protocol';

export interface AgentTaskRecord extends AgentTaskSummary {
  projectRoot: string;
  cwd: string;
  successExitCodes: number[];
  operationKey: string;
  dedupeKey: string;
  executorPid?: number;
  terminalIntentEnqueued?: boolean;
  cancelRequested?: boolean;
}

export interface AgentTaskManagerOptions {
  userDataPath: string;
  commandShell: AgentCommandShell;
  terminalFactory?: (options: AgentCommandPtyOptions) => AgentCommandPty;
  onChanged?: (task: AgentTaskRecord) => Promise<void> | void;
}

export interface AgentTaskQuery {
  taskId: string;
  cursor?: string;
  maxBytes?: number;
}

const DEFAULT_TAIL_BYTES = 16 * 1024;
const MAX_TAIL_BYTES = 256 * 1024;

/**
 * Owns process lifetime, durable task metadata, and task logs. Session history
 * receives a compact summary through `onChanged`; the full record stays here.
 */
export class AgentTaskManager {
  private readonly runtimes = new Map<string, { task: AgentTaskRecord; pty: AgentCommandPty }>();
  private readonly loaded = new Map<string, Map<string, AgentTaskRecord>>();
  private readonly persistChains = new Map<string, Promise<void>>();
  private readonly completions = new Map<string, Promise<void>>();

  constructor(private readonly options: AgentTaskManagerOptions) {}

  async recover(projectRoot: string): Promise<AgentTaskRecord[]> {
    const tasks = await this.loadProject(projectRoot);
    for (const task of tasks) {
      if (task.status !== 'starting' && task.status !== 'running') continue;
      // A PTY cannot be trusted across a process restart. Marking it lost is
      // explicit and prevents an unsafe command replay.
      task.status = 'lost';
      task.completedAt = Date.now();
      task.error = 'The task was running when Iris restarted and could not be reconnected.';
      await this.persist(projectRoot);
      await this.notify(task);
    }
    return tasks.map((task) => structuredClone(task));
  }

  async start(input: {
    projectRoot: string;
    sessionId: string;
    intentId: string;
    toolCallId: string;
    command: string;
    title: string;
    cwd: string;
    successExitCodes?: number[];
  }): Promise<AgentToolOperationResult> {
    const tasks = await this.loadProject(input.projectRoot);
    const operationKey = `${input.sessionId}:${input.toolCallId}`;
    const existing = tasks.find((candidate) => candidate.operationKey === operationKey);
    if (existing) return taskResult(existing, `Task already exists for operation ${operationKey}.`);
    const taskId = randomUUID();
    const successExitCodes = normalizeSuccessExitCodes(input.successExitCodes);
    const task: AgentTaskRecord = {
      taskId,
      sessionId: input.sessionId,
      intentId: input.intentId,
      title: input.title.trim() || input.command.trim().split(/\s+/u)[0] || 'Background task',
      command: input.command,
      status: 'queued',
      createdAt: Date.now(),
      outputBytes: 0,
      projectRoot: input.projectRoot,
      cwd: input.cwd,
      successExitCodes,
      operationKey,
      dedupeKey: `task-terminal:${taskId}`,
      logRef: this.logPath(input.projectRoot, taskId),
    };
    const logRef = task.logRef!;
    await fs.mkdir(dirname(logRef), { recursive: true });
    await fs.writeFile(logRef, '', { flag: 'a' });
    this.loaded.get(input.projectRoot)!.set(task.taskId, task);
    await this.persist(input.projectRoot);
    await this.notify(task);

    task.status = 'starting';
    task.startedAt = Date.now();
    await this.persist(input.projectRoot);
    await this.notify(task);

    let pty: AgentCommandPty;
    try {
      pty = this.options.terminalFactory?.({
        terminalId: taskId,
        command: task.command,
        cwd: task.cwd,
        outputPath: task.logRef!,
        commandShell: this.options.commandShell,
        processTreeKillFn: defaultProcessTreeKiller(),
      }) ?? new AgentCommandPty({
        terminalId: taskId,
        command: task.command,
        cwd: task.cwd,
        outputPath: task.logRef!,
        commandShell: this.options.commandShell,
        processTreeKillFn: defaultProcessTreeKiller(),
      });
    } catch (error) {
      task.status = 'failed';
      task.completedAt = Date.now();
      task.error = error instanceof Error ? error.message : String(error);
      await this.persist(input.projectRoot);
      await this.notify(task);
      return taskResult(task, 'Task failed to start.');
    }
    if (pty.pid !== undefined) task.executorPid = pty.pid;
    this.runtimes.set(taskId, { task, pty });
    if (task.completedAt === undefined) {
      task.status = 'running';
      await this.persist(input.projectRoot);
      await this.notify(task);
    } else {
      // A concurrent cancel may have settled a task while its PTY was being
      // created. Do not resurrect the record; close the late process instead.
      pty.abort();
    }
    const completion = pty.result.then(
      (result) => this.finish(task, result.exitCode, result.outputBytes, result.termination),
      (error: unknown) => this.fail(task, error instanceof Error ? error.message : String(error)),
    );
    this.completions.set(taskId, completion);
    void completion.finally(() => {
      if (this.completions.get(taskId) === completion) this.completions.delete(taskId);
    }).catch(() => undefined);
    return taskResult(task, task.completedAt === undefined ? 'Task started.' : 'Task was canceled before it started.');
  }

  async get(query: AgentTaskQuery, projectRoot: string): Promise<AgentToolOperationResult> {
    const task = (await this.loadProject(projectRoot)).find((candidate) => candidate.taskId === query.taskId);
    if (!task) throw new Error(`Task not found: ${query.taskId}`);
    const requestedMaxBytes = query.maxBytes ?? DEFAULT_TAIL_BYTES;
    const maxBytes = Number.isFinite(requestedMaxBytes)
      ? Math.min(MAX_TAIL_BYTES, Math.max(1, Math.floor(requestedMaxBytes)))
      : DEFAULT_TAIL_BYTES;
    const bytes = await fs.readFile(task.logRef!).catch(() => Buffer.alloc(0));
    const offset = decodeCursor(query.cursor);
    const paged = query.cursor !== undefined;
    const start = paged
      ? alignUtf8Start(bytes, Math.min(bytes.length, Math.max(0, offset)))
      : alignUtf8Start(bytes, Math.max(0, bytes.length - maxBytes));
    const end = paged
      ? alignUtf8End(bytes, Math.min(bytes.length, start + maxBytes))
      : bytes.length;
    const output = bytes.subarray(start, end).toString('utf8');
    const truncated = paged ? end < bytes.length : start > 0;
    const cursor = encodeCursor(end);
    const text = JSON.stringify({
      taskId: task.taskId,
      status: task.status,
      title: task.title,
      command: task.command,
      exitCode: task.exitCode ?? null,
      outputBytes: task.outputBytes,
      output,
      ...(truncated ? { nextCursor: paged ? cursor : encodeCursor(0) } : {}),
      ...(task.logRef ? { logRef: task.logRef } : {}),
      ...(task.error ? { error: task.error } : {}),
    });
    return {
      kind: 'task',
      taskId: task.taskId,
      status: task.status,
      outputText: text,
      outputTruncated: truncated,
      ...(task.logRef ? { logRef: task.logRef } : {}),
    };
  }

  async list(projectRoot: string, scope: 'active' | 'all' = 'active', cursor?: string, limit = 50): Promise<AgentToolOperationResult> {
    const tasks = await this.loadProject(projectRoot);
    const offset = decodeCursor(cursor);
    const filtered = scope === 'all'
      ? tasks
      : tasks.filter((task) => task.status === 'queued' || task.status === 'starting' || task.status === 'running');
    const normalizedLimit = Number.isFinite(limit)
      ? Math.min(100, Math.max(1, Math.floor(limit)))
      : 50;
    const selected = filtered.slice(offset, offset + normalizedLimit);
    const next = offset + selected.length < filtered.length ? encodeCursor(offset + selected.length) : undefined;
    return {
      kind: 'task',
      outputText: JSON.stringify({
        scope,
        tasks: selected.map(publicTask),
        ...(next ? { nextCursor: next } : {}),
      }),
      ...(next ? { outputTruncated: true } : {}),
    };
  }

  async cancel(taskId: string, projectRoot: string): Promise<AgentToolOperationResult> {
    const task = (await this.loadProject(projectRoot)).find((candidate) => candidate.taskId === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status === 'queued' || task.status === 'starting' || task.status === 'running') {
      task.cancelRequested = true;
      const runtime = this.runtimes.get(taskId);
      if (runtime) runtime.pty.abort();
      else {
        task.status = 'canceled';
        task.completedAt = Date.now();
        await this.persist(projectRoot);
        await this.notify(task);
      }
      return taskResult(task, 'Cancellation requested; final state follows cleanup.');
    }
    return taskResult(task, `Task is already ${task.status}.`);
  }

  async markTerminalIntentEnqueued(taskId: string, projectRoot: string): Promise<void> {
    const task = (await this.loadProject(projectRoot)).find((candidate) => candidate.taskId === taskId);
    if (!task || task.terminalIntentEnqueued) return;
    task.terminalIntentEnqueued = true;
    await this.persist(projectRoot);
  }

  async recordsForSession(projectRoot: string, sessionId: string): Promise<AgentTaskRecord[]> {
    return (await this.loadProject(projectRoot)).filter((task) => task.sessionId === sessionId)
      .map((task) => structuredClone(task));
  }

  async shutdown(): Promise<void> {
    const active = [...this.runtimes.values()];
    for (const { task } of active) {
      if (task.completedAt !== undefined) continue;
      task.status = 'lost';
      task.completedAt = Date.now();
      task.error = 'Iris stopped before the background task completed.';
      await this.persist(task.projectRoot);
      await this.notify(task);
    }
    await Promise.allSettled(active.map(async ({ pty }) => {
      pty.abort();
      await pty.result.catch(() => undefined);
      pty.dispose();
    }));
    await Promise.allSettled([...this.completions.values()]);
    this.runtimes.clear();
  }

  private async finish(
    task: AgentTaskRecord,
    exitCode: number,
    outputBytes: number,
    termination: 'natural' | 'timeout' | 'aborted' | undefined,
  ): Promise<void> {
    if (task.completedAt !== undefined) return;
    task.outputBytes = outputBytes;
    task.exitCode = exitCode;
    task.completedAt = Date.now();
    task.status = task.cancelRequested || termination === 'aborted' ? 'canceled' :
      task.successExitCodes.includes(exitCode) ? 'succeeded' : 'failed';
    if (task.status === 'failed') task.error = termination === 'timeout'
      ? 'Task process timed out.'
      : `Task exited with code ${String(exitCode)}.`;
    this.runtimes.delete(task.taskId);
    await this.persist(task.projectRoot);
    await this.notify(task);
  }

  private async fail(task: AgentTaskRecord, error: string): Promise<void> {
    if (task.completedAt !== undefined) return;
    task.status = task.cancelRequested ? 'canceled' : 'failed';
    task.completedAt = Date.now();
    task.error = error;
    this.runtimes.delete(task.taskId);
    await this.persist(task.projectRoot);
    await this.notify(task);
  }

  private async loadProject(projectRoot: string): Promise<AgentTaskRecord[]> {
    const existing = this.loaded.get(projectRoot);
    if (existing) return [...existing.values()];
    const path = this.tasksPath(projectRoot);
    let records: AgentTaskRecord[] = [];
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
      if (Array.isArray(parsed)) records = parsed.filter(isTaskRecord).map((task) => ({
        ...task,
        projectRoot,
      }));
    } catch {
      // Missing or damaged task metadata starts an empty project index; logs
      // remain untouched and can still be associated manually by taskId.
    }
    const map = new Map(records.map((task) => [task.taskId, task]));
    this.loaded.set(projectRoot, map);
    return [...map.values()];
  }

  private async persist(projectRoot: string): Promise<void> {
    const previous = this.persistChains.get(projectRoot) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const map = this.loaded.get(projectRoot);
      if (!map) return;
      await writeFileAtomic(this.tasksPath(projectRoot), JSON.stringify([...map.values()], null, 2) + '\n');
    });
    this.persistChains.set(projectRoot, next);
    try {
      await next;
    } finally {
      if (this.persistChains.get(projectRoot) === next) this.persistChains.delete(projectRoot);
    }
  }

  private async notify(task: AgentTaskRecord): Promise<void> {
    try {
      const pending = this.options.onChanged?.(structuredClone(task));
      void Promise.resolve(pending).catch(() => undefined);
    } catch {
      // A renderer/session projection must not affect process cleanup or task
      // durability. Recovery will reconcile the summary on the next refresh.
    }
  }

  private tasksPath(projectRoot: string): string {
    return join(resolve(this.options.userDataPath), 'iris-agent-tasks', projectKey(projectRoot), 'tasks.json');
  }

  private logPath(projectRoot: string, taskId: string): string {
    return join(resolve(this.options.userDataPath), 'iris-agent-tasks', projectKey(projectRoot), 'logs', taskId + '.log');
  }
}

function projectKey(projectRoot: string): string {
  return createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 32);
}

function normalizeSuccessExitCodes(value: number[] | undefined): number[] {
  const normalized = value?.filter((code) => Number.isSafeInteger(code)) ?? [];
  return normalized.length > 0 ? [...new Set(normalized)] : [0];
}

function taskResult(task: AgentTaskRecord, message: string): AgentToolOperationResult {
  return {
    kind: 'task',
    taskId: task.taskId,
    status: task.status,
    outputText: JSON.stringify({
      message,
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      command: task.command,
      ...(task.logRef ? { logRef: task.logRef } : {}),
    }),
    ...(task.logRef ? { logRef: task.logRef } : {}),
  };
}

function publicTask(task: AgentTaskRecord): AgentTaskSummary {
  const {
    projectRoot: _projectRoot,
    cwd: _cwd,
    successExitCodes: _successExitCodes,
    operationKey: _operationKey,
    dedupeKey: _dedupeKey,
    executorPid: _executorPid,
    cancelRequested: _cancelRequested,
    terminalIntentEnqueued: _terminalIntentEnqueued,
    ...summary
  } = structuredClone(task);
  return summary;
}

function isTaskRecord(value: unknown): value is AgentTaskRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.taskId === 'string' && typeof item.sessionId === 'string' &&
    typeof item.intentId === 'string' && typeof item.title === 'string' &&
    typeof item.command === 'string' && typeof item.projectRoot === 'string' &&
    typeof item.cwd === 'string' && typeof item.createdAt === 'number' &&
    typeof item.outputBytes === 'number' && Array.isArray(item.successExitCodes) &&
    item.successExitCodes.every((code) => typeof code === 'number' && Number.isSafeInteger(code)) &&
    typeof item.operationKey === 'string' && typeof item.dedupeKey === 'string' &&
    typeof item.logRef === 'string' &&
    ['queued', 'starting', 'running', 'succeeded', 'failed', 'canceled', 'lost'].includes(String(item.status));
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).offset === 'number') {
      const offset = (parsed as Record<string, unknown>).offset;
      if (typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0) return offset;
    }
  } catch {
    // Invalid cursors are treated as the beginning of the immutable log.
  }
  return 0;
}

function alignUtf8Start(bytes: Buffer, offset: number): number {
  let start = offset;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return start;
}

function alignUtf8End(bytes: Buffer, offset: number): number {
  let end = offset;
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}
