import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTempDataDir, removeTempDataDir } from '../persistence';
import type { AgentCommandPty } from './command-pty';
import { AgentTaskManager } from './task-manager';

const commandShell = {
  kind: 'powershell' as const,
  executable: 'pwsh.exe',
  displayName: 'PowerShell 7',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakePty() {
  const result = deferred<{
    terminalId: string;
    exitCode: number;
    outputPath: string;
    outputBytes: number;
    finalCursor: number;
    shown: boolean;
    plainText: string;
    outputTruncated: boolean;
    termination?: 'natural' | 'timeout' | 'aborted';
  }>();
  return {
    pid: 42,
    result: result.promise,
    abort: vi.fn(),
    dispose: vi.fn(),
    complete: (exitCode: number, outputPath: string, termination?: 'natural' | 'timeout' | 'aborted') =>
      result.resolve({
        terminalId: 'task', exitCode, outputPath, outputBytes: 0, finalCursor: 0,
        shown: false, plainText: '', outputTruncated: false, ...(termination ? { termination } : {}),
      }),
  };
}

describe('AgentTaskManager', () => {
  it('persists task lifecycle, deduplicates starts, paginates UTF-8 logs, and cancels idempotently', async () => {
    const userDataPath = await createTempDataDir('iris-agent-task-manager-');
    const projectRoot = await createTempDataDir('iris-agent-task-project-');
    const ptys: ReturnType<typeof fakePty>[] = [];
    try {
      const manager = new AgentTaskManager({
        userDataPath,
        commandShell,
        terminalFactory: () => {
          const pty = fakePty();
          ptys.push(pty);
          return pty as unknown as AgentCommandPty;
        },
      });
      const started = await manager.start({
        projectRoot,
        sessionId: 'session-1',
        intentId: 'intent-1',
        toolCallId: 'call-1',
        command: 'echo task',
        title: 'Build task',
        cwd: projectRoot,
      });
      expect(started).toMatchObject({ kind: 'task', status: 'running' });
      if (started.kind !== 'task' || !started.taskId || !started.logRef) throw new Error('task did not start');
      const startedTaskId = started.taskId;
      const startedLogRef = started.logRef;
      const duplicate = await manager.start({
        projectRoot,
        sessionId: 'session-1',
        intentId: 'intent-1',
        toolCallId: 'call-1',
        command: 'echo task',
        title: 'Build task',
        cwd: projectRoot,
      });
      expect(duplicate).toMatchObject({ kind: 'task', taskId: startedTaskId });
      expect(ptys).toHaveLength(1);

      await fs.mkdir(dirname(startedLogRef), { recursive: true });
      await fs.writeFile(startedLogRef, '第一行\n第二行\n', 'utf8');
      const cursor = Buffer.from(JSON.stringify({ offset: 0 }), 'utf8').toString('base64url');
      const firstPage = await manager.get({ taskId: startedTaskId, cursor, maxBytes: 4 }, projectRoot);
      expect(firstPage).toMatchObject({ kind: 'task', outputTruncated: true });
      if (firstPage.kind !== 'task') throw new Error('task page missing');
      const firstPayload = JSON.parse(firstPage.outputText) as { output: string; nextCursor?: string };
      expect(firstPayload.output).not.toContain('\ufffd');
      expect(firstPayload.nextCursor).toBeDefined();

      ptys[0]!.complete(0, startedLogRef);
      await vi.waitFor(async () => {
        const result = await manager.get({ taskId: startedTaskId }, projectRoot);
        expect(result).toMatchObject({ kind: 'task', status: 'succeeded' });
      });

      const canceled = await manager.start({
        projectRoot,
        sessionId: 'session-1',
        intentId: 'intent-1',
        toolCallId: 'call-2',
        command: 'watch task',
        title: 'Watch task',
        cwd: projectRoot,
      });
      if (canceled.kind !== 'task' || !canceled.taskId) throw new Error('second task did not start');
      const canceledTaskId = canceled.taskId;
      const canceledLogRef = canceled.logRef ?? '';
      await manager.cancel(canceledTaskId, projectRoot);
      expect(ptys[1]!.abort).toHaveBeenCalledOnce();
      ptys[1]!.complete(130, canceledLogRef, 'aborted');
      await vi.waitFor(async () => {
        const result = await manager.get({ taskId: canceledTaskId }, projectRoot);
        expect(result).toMatchObject({ kind: 'task', status: 'canceled' });
      });
    } finally {
      await removeTempDataDir(userDataPath);
      await removeTempDataDir(projectRoot);
    }
  });

  it('pages the raw log for the renderer by byte cursor and relative cwd', async () => {
    const userDataPath = await createTempDataDir('iris-agent-task-log-');
    const projectRoot = await createTempDataDir('iris-agent-task-log-project-');
    try {
      const manager = new AgentTaskManager({
        userDataPath,
        commandShell,
        terminalFactory: () => fakePty() as unknown as AgentCommandPty,
      });
      const started = await manager.start({
        projectRoot,
        sessionId: 'session-1',
        intentId: 'intent-1',
        toolCallId: 'call-1',
        command: 'tail -f app.log',
        title: 'Dev server',
        cwd: join(projectRoot, 'packages', 'app'),
      });
      if (started.kind !== 'task' || !started.taskId || !started.logRef) throw new Error('task did not start');
      const taskId = started.taskId;
      const logRef = started.logRef;
      await fs.mkdir(dirname(logRef), { recursive: true });
      await fs.writeFile(logRef, 'aaaaaaaaaa\nbbbbbbbbbb\n', 'utf8');

      const tail = await manager.readLog({ taskId, sessionId: 'session-1', maxBytes: 11 }, projectRoot);
      expect(tail.data).toBe('bbbbbbbbbb\n');
      expect(tail).toMatchObject({
        hasOlder: true,
        truncated: true,
        nextCursor: 22,
        outputBytes: 22,
      });
      expect(tail.task.cwd).toBe(join('packages', 'app'));

      // A poll that caught up still reports where to resume, which is what
      // keeps the dialog from re-reading the window it already rendered.
      const caughtUp = await manager.readLog({
        taskId, sessionId: 'session-1', cursor: tail.nextCursor, maxBytes: 11,
      }, projectRoot);
      expect(caughtUp.data).toBe('');
      expect(caughtUp.nextCursor).toBe(22);

      await fs.appendFile(logRef, 'cccc\n');
      const appended = await manager.readLog({
        taskId, sessionId: 'session-1', cursor: caughtUp.nextCursor, maxBytes: 11,
      }, projectRoot);
      expect(appended.data).toBe('cccc\n');
      expect(appended).toMatchObject({
        nextCursor: 27,
        outputBytes: 27,
        truncated: true,
        hasOlder: true,
      });

      // A window that already covers the file offers no older history.
      const whole = await manager.readLog({ taskId, sessionId: 'session-1', maxBytes: 4096 }, projectRoot);
      expect(whole.data).toBe('aaaaaaaaaa\nbbbbbbbbbb\ncccc\n');
      expect(whole).toMatchObject({ hasOlder: false, truncated: false, nextCursor: 27 });

      await expect(manager.readLog({ taskId, sessionId: 'session-2' }, projectRoot))
        .rejects.toThrow('does not belong to this session');

      const rooted = await manager.start({
        projectRoot,
        sessionId: 'session-1',
        intentId: 'intent-1',
        toolCallId: 'call-2',
        command: 'npm run build',
        title: 'Build',
        cwd: projectRoot,
      });
      if (rooted.kind !== 'task' || !rooted.taskId) throw new Error('second task did not start');
      const rootedLog = await manager.readLog({ taskId: rooted.taskId, sessionId: 'session-1' }, projectRoot);
      expect(rootedLog.task.cwd).toBe('.');
      expect(rootedLog).toMatchObject({ data: '', hasOlder: false, truncated: false });
    } finally {
      await removeTempDataDir(userDataPath);
      await removeTempDataDir(projectRoot);
    }
  });
});
