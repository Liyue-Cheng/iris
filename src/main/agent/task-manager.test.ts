import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
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
});
