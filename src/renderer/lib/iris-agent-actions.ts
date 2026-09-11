import { CHANNELS } from '@shared/protocol';
import type {
  IrisAgentAnchor,
  IrisAgentAttachmentData,
  IrisAgentAttachmentUpload,
  IrisAgentHistoryEntry,
  IrisAgentModelCatalog,
  IrisAgentModelRef,
  IrisAgentSessionInfo,
  IrisAgentTaskLog,
  IrisAgentTerminalReplay,
  ProjectScope,
} from '@shared/types';
import { editorStore } from '@renderer/stores/editor-store';
import { projectStore } from '@renderer/stores/project-store';
import { irisAgentAnchorKey, irisAgentStore } from '@renderer/stores/iris-agent-store';
import { sessionViewStore } from '@renderer/stores/session-view-store';
import { irisAgentSessionKey } from './session-projection';
import { attemptAction, runUserAction, type ActionOutcome } from './action-runtime';
import { notify } from '@renderer/stores/notification-store';
import { confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { sessionCloseOutcome, type SessionCloseOutcome } from './session-close-outcome';

function scopeOrThrow(): ProjectScope {
  const scope = projectStore.get().scope;
  if (!scope) throw new Error('Open a project before starting Iris Agent.');
  return scope;
}

function projectScoped<T extends Record<string, unknown>>(scope: ProjectScope, payload: T): T & {
  expectedScope: ProjectScope;
} {
  return { ...payload, expectedScope: scope };
}

function commandPrecondition(sessionId: string): { commandId: string; expectedRevision: number } {
  const session = irisAgentStore.get().sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error('The Iris Agent session is no longer available.');
  return { commandId: crypto.randomUUID(), expectedRevision: session.revision };
}

function intentPrecondition(sessionId: string): {
  commandId: string;
  expectedRevision: number;
  expectedIntentId: string;
} {
  const session = irisAgentStore.get().sessions.find((candidate) => candidate.id === sessionId);
  if (!session?.currentIntentId) throw new Error('The Iris Agent Intent is no longer available.');
  return { ...commandPrecondition(sessionId), expectedIntentId: session.currentIntentId };
}

/**
 * Bring the middle pane to the session's anchor BEFORE creating the session.
 * The right pane is anchor-driven (issue 2026-06-16): a new session only shows
 * when `view` already matches its anchor. The terminal launchers do the same
 * in `session-actions.ts`; the Agent entry points (left-pane +, right-pane +,
 * launch pad) share this single path. A rejected navigation (editor conflict,
 * missing document) aborts the open instead of creating an invisible session.
 */
async function navigateToAnchor(anchor: IrisAgentAnchor): Promise<boolean> {
  if (anchor.kind === 'document') return projectStore.selectDoc(anchor.path);
  if (anchor.path === '.iris') return projectStore.selectRoot();
  return projectStore.selectWorkspace(anchor.path);
}

export async function openIrisAgent(anchor: IrisAgentAnchor): Promise<IrisAgentSessionInfo | null> {
  const outcome = await attemptAction(async () => {
    if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return null;
    if (!(await navigateToAnchor(anchor))) return null;
    const scope = scopeOrThrow();
    const session = await window.api.invoke<
      { anchor: IrisAgentAnchor; expectedScope: ProjectScope },
      IrisAgentSessionInfo
    >(CHANNELS.IRIS_AGENT_OPEN, projectScoped(scope, { anchor }));
    irisAgentStore.handleChanged(session);
    sessionViewStore.select(scope, irisAgentAnchorKey(session.anchor), irisAgentSessionKey(session.id));
    return session;
  });
  if (outcome.status === 'ok') return outcome.value;
  if (outcome.status === 'failed') {
    notify({
      dedupeKey: 'iris-agent:open',
      title: 'Iris Agent 打开失败',
      message: outcome.error.message,
      domain: outcome.error.domain,
      ...(outcome.error.incidentId ? { incidentId: outcome.error.incidentId } : {}),
    });
  }
  return null;
}

export async function sendIrisAgentMessage(
  sessionId: string,
  message: string,
  attachments: readonly IrisAgentAttachmentUpload[] = [],
): Promise<boolean> {
  const trimmed = message.trim();
  const session = irisAgentStore.get().sessions.find((candidate) => candidate.id === sessionId);
  const canStartFromDocument = session?.anchor.kind === 'document' && session.intents.length === 0;
  if (!trimmed && !canStartFromDocument) return false;
  const outcome = await runUserAction(
    {
      title: 'Iris Agent 发送失败',
      dedupeKey: 'iris-agent:send:' + sessionId,
    },
    async () => {
      if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return false;
      const scope = scopeOrThrow();
      const precondition = commandPrecondition(sessionId);
      const session = await window.api.invoke<
        {
          sessionId: string;
          message: string;
          attachments?: IrisAgentAttachmentUpload[];
          commandId: string;
          expectedRevision: number;
          expectedScope: ProjectScope;
        },
        IrisAgentSessionInfo
      >(CHANNELS.IRIS_AGENT_SEND, projectScoped(scope, {
        sessionId,
        message: trimmed,
        ...(attachments.length ? { attachments: [...attachments] } : {}),
        ...precondition,
      }));
      irisAgentStore.handleChanged(session);
      return true;
    },
  );
  return outcome.status === 'ok' && outcome.value;
}

export async function stopIrisAgent(sessionId: string): Promise<void> {
  await runUserAction(
    {
      title: 'Iris Agent 停止失败',
      dedupeKey: 'iris-agent:stop:' + sessionId,
    },
    async () => {
      const scope = scopeOrThrow();
      const precondition = intentPrecondition(sessionId);
      const session = await window.api.invoke<
        {
          sessionId: string;
          commandId: string;
          expectedRevision: number;
          expectedIntentId: string;
          expectedScope: ProjectScope;
        },
        IrisAgentSessionInfo
      >(CHANNELS.IRIS_AGENT_STOP, projectScoped(scope, { sessionId, ...precondition }));
      irisAgentStore.handleChanged(session);
    },
  );
}

/**
 * Read one page of a task's raw log. `cursor` is a byte offset, not the opaque
 * cursor of the model-facing `task_get`: the dialog owns its own paging and
 * must not decode a protocol meant for the model.
 */
export async function readIrisAgentTaskLog(
  sessionId: string,
  taskId: string,
  request: { cursor?: number; maxBytes: number },
): Promise<IrisAgentTaskLog> {
  const scope = scopeOrThrow();
  return window.api.invoke<{
    sessionId: string;
    taskId: string;
    cursor?: number;
    maxBytes?: number;
    expectedScope: ProjectScope;
  }, IrisAgentTaskLog>(CHANNELS.IRIS_AGENT_TASK_LOG, projectScoped(scope, {
    sessionId,
    taskId,
    ...request,
  }));
}

export async function cancelIrisAgentTask(sessionId: string, taskId: string): Promise<void> {
  await runUserAction(
    { title: '后台任务取消失败', dedupeKey: `iris-agent:task-cancel:${taskId}` },
    async () => {
      const scope = scopeOrThrow();
      const session = await window.api.invoke<{
        sessionId: string;
        taskId: string;
        expectedScope: ProjectScope;
      }, IrisAgentSessionInfo>(CHANNELS.IRIS_AGENT_TASK_CANCEL, projectScoped(scope, { sessionId, taskId }));
      irisAgentStore.handleChanged(session);
    },
  );
}

export async function resumeIrisAgent(sessionId: string): Promise<void> {
  await runUserAction(
    {
      title: 'Iris Agent 恢复失败',
      dedupeKey: 'iris-agent:resume:' + sessionId,
    },
    async () => {
      if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return;
      const scope = scopeOrThrow();
      const precondition = commandPrecondition(sessionId);
      const session = await window.api.invoke<
        {
          sessionId: string;
          commandId: string;
          expectedRevision: number;
          expectedScope: ProjectScope;
        },
        IrisAgentSessionInfo
      >(CHANNELS.IRIS_AGENT_RETRY, projectScoped(scope, { sessionId, ...precondition }));
      irisAgentStore.handleChanged(session);
    },
  );
}

export async function rewindIrisAgent(sessionId: string): Promise<void> {
  const confirmed = await confirmDialog({
    title: '回退 Iris Agent 上一项意图？',
    message: '将移除最后一项意图并回滚仍可安全还原的文件改动；终端命令和外部副作用会保留。',
    confirmText: '回退意图',
    tone: 'destructive',
  });
  if (!confirmed) return;
  await runUserAction(
    {
      title: 'Iris Agent 回退失败',
      dedupeKey: 'iris-agent:rewind:' + sessionId,
    },
    async () => {
      const scope = scopeOrThrow();
      const precondition = commandPrecondition(sessionId);
      const session = await window.api.invoke<
        {
          sessionId: string;
          commandId: string;
          expectedRevision: number;
          expectedScope: ProjectScope;
        },
        IrisAgentSessionInfo
      >(CHANNELS.IRIS_AGENT_REWIND, projectScoped(scope, { sessionId, ...precondition }));
      irisAgentStore.handleChanged(session);
    },
  );
}

export async function branchIrisAgent(
  sessionId: string,
  throughIntentId: string,
  fromInput = false,
): Promise<IrisAgentSessionInfo | null> {
  const outcome = await attemptAction(async () => {
    const scope = scopeOrThrow();
    const precondition = commandPrecondition(sessionId);
    const session = await window.api.invoke<
      {
        sessionId: string;
        throughIntentId: string;
        commandId: string;
        expectedRevision: number;
        expectedScope: ProjectScope;
      },
      IrisAgentSessionInfo
    >(fromInput ? CHANNELS.IRIS_AGENT_BRANCH_INPUT : CHANNELS.IRIS_AGENT_BRANCH, projectScoped(scope, {
      sessionId,
      throughIntentId,
      ...precondition,
    }));
    irisAgentStore.handleChanged(session);
    sessionViewStore.select(scope, irisAgentAnchorKey(session.anchor), irisAgentSessionKey(session.id));
    return session;
  });
  if (outcome.status === 'ok') return outcome.value;
  if (outcome.status === 'failed') {
    notify({
      dedupeKey: `iris-agent:branch:${fromInput ? 'input' : 'reply'}:${sessionId}:${throughIntentId}`,
      title: 'Iris Agent 分支失败',
      message: outcome.error.message,
      domain: outcome.error.domain,
      ...(outcome.error.incidentId ? { incidentId: outcome.error.incidentId } : {}),
    });
  }
  return null;
}

export async function setIrisAgentModel(
  sessionId: string,
  model: IrisAgentModelRef,
): Promise<void> {
  await runUserAction(
    {
      title: 'Iris Agent 模型切换失败',
      dedupeKey: `iris-agent:model:${sessionId}`,
    },
    async () => {
      const scope = scopeOrThrow();
      const precondition = commandPrecondition(sessionId);
      const session = await window.api.invoke<
        {
          sessionId: string;
          provider: string;
          modelId: string;
          commandId: string;
          expectedRevision: number;
          expectedScope: ProjectScope;
        },
        IrisAgentSessionInfo
      >(CHANNELS.IRIS_AGENT_SET_MODEL, projectScoped(scope, {
        sessionId,
        provider: model.provider,
        modelId: model.modelId,
        ...precondition,
      }));
      irisAgentStore.handleChanged(session);
    },
  );
}

/** The anchor's Agent history: live and closed instances, metadata only. */
export async function listIrisAgentHistory(
  anchor: IrisAgentAnchor,
): Promise<IrisAgentHistoryEntry[]> {
  const scope = scopeOrThrow();
  return window.api.invoke<
    { anchor: IrisAgentAnchor; expectedScope: ProjectScope },
    IrisAgentHistoryEntry[]
  >(CHANNELS.IRIS_AGENT_HISTORY, projectScoped(scope, { anchor }));
}

/**
 * Switch back into a history Session. A closed instance is reopened under the
 * same identity — nothing is forked — and selected so the pane follows the
 * user's click.
 */
export async function reopenIrisAgent(sessionId: string): Promise<IrisAgentSessionInfo | null> {
  return selectAfter(await attemptAction(async () => {
    const scope = scopeOrThrow();
    const session = await window.api.invoke<
      { sessionId: string; expectedScope: ProjectScope },
      IrisAgentSessionInfo
    >(CHANNELS.IRIS_AGENT_REOPEN, projectScoped(scope, { sessionId }));
    irisAgentStore.handleChanged(session);
    sessionViewStore.select(scope, irisAgentAnchorKey(session.anchor), irisAgentSessionKey(session.id));
    return session;
  }), 'iris-agent:reopen:' + sessionId, 'Iris Agent 历史会话恢复失败');
}

/**
 * Open a new live instance that inherits the selected history Session's Trace.
 * The source Session is untouched; the new one anchors to the same document.
 */
export async function restoreIrisAgent(sessionId: string): Promise<IrisAgentSessionInfo | null> {
  return selectAfter(await attemptAction(async () => {
    const scope = scopeOrThrow();
    const session = await window.api.invoke<
      { sessionId: string; expectedScope: ProjectScope },
      IrisAgentSessionInfo
    >(CHANNELS.IRIS_AGENT_RESTORE, projectScoped(scope, { sessionId }));
    irisAgentStore.handleChanged(session);
    sessionViewStore.select(scope, irisAgentAnchorKey(session.anchor), irisAgentSessionKey(session.id));
    return session;
  }), 'iris-agent:restore:' + sessionId, 'Iris Agent 新实例创建失败');
}

/** Main-authoritative count used by the single bulk status confirmation. */
export async function countIrisAgentDocuments(documentPaths: readonly string[]): Promise<number> {
  if (documentPaths.length === 0) return 0;
  const scope = scopeOrThrow();
  return window.api.invoke<
    { documentPaths: string[]; expectedScope: ProjectScope },
    number
  >(
    CHANNELS.IRIS_AGENT_COUNT_DOCUMENTS,
    projectScoped(scope, { documentPaths: [...new Set(documentPaths)] }),
  );
}

/**
 * Main-authoritative archival used by document status transitions. Main
 * re-enumerates the latest Sessions for these anchors, so a stale renderer
 * revision cannot let Done silently leave an Agent instance open.
 */
export async function archiveIrisAgentDocuments(documentPaths: readonly string[]): Promise<number> {
  if (documentPaths.length === 0) return 0;
  const scope = scopeOrThrow();
  const archived = await window.api.invoke<
    { documentPaths: string[]; expectedScope: ProjectScope },
    number
  >(
    CHANNELS.IRIS_AGENT_ARCHIVE_DOCUMENTS,
    projectScoped(scope, { documentPaths: [...new Set(documentPaths)] }),
  );
  return archived;
}

/**
 * Close one live instance without a per-instance dialog. The bulk status change
 * already asked once, so re-prompting here would be a second, redundant modal.
 * Never throws: one failed instance must not abort the whole status change.
 */
export async function closeIrisAgentInstance(sessionId: string): Promise<void> {
  const session = irisAgentStore.get().sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return;
  const scope = projectStore.get().scope;
  if (!scope) return;
  try {
    await window.api.invoke<
      {
        sessionId: string;
        commandId: string;
        expectedRevision: number;
        confirmBusy?: boolean;
        expectedScope: ProjectScope;
      },
      void
    >(CHANNELS.IRIS_AGENT_CLOSE, projectScoped(scope, {
      sessionId,
      commandId: crypto.randomUUID(),
      expectedRevision: session.revision,
      confirmBusy: true,
    }));
    irisAgentStore.handleDestroyed(sessionId);
  } catch (err) {
    console.warn('[iris-agent] closing a document Agent instance failed', err);
  }
}

async function selectAfter(
  outcome: ActionOutcome<IrisAgentSessionInfo>,
  dedupeKey: string,
  title: string,
): Promise<IrisAgentSessionInfo | null> {
  if (outcome.status === 'ok') return outcome.value;
  if (outcome.status === 'failed') {
    notify({
      dedupeKey,
      title,
      message: outcome.error.message,
      domain: outcome.error.domain,
      ...(outcome.error.incidentId ? { incidentId: outcome.error.incidentId } : {}),
    });
  }
  return null;
}

export async function listIrisAgentModels(forceRefresh = false): Promise<IrisAgentModelCatalog> {
  const scope = scopeOrThrow();
  return window.api.invoke<{ expectedScope: ProjectScope; forceRefresh?: boolean }, IrisAgentModelCatalog>(
    CHANNELS.IRIS_AGENT_MODELS,
    { expectedScope: scope, ...(forceRefresh ? { forceRefresh: true } : {}) },
  );
}

export async function openIrisAgentContext(sessionId: string, intentId: string): Promise<void> {
  await runUserAction(
    {
      title: '上下文 artifact 打开失败',
      dedupeKey: `iris-agent:context:${sessionId}:${intentId}`,
    },
    async () => {
      const scope = scopeOrThrow();
      await window.api.invoke<
        { sessionId: string; intentId: string; expectedScope: ProjectScope },
        void
      >(
        CHANNELS.IRIS_AGENT_OPEN_CONTEXT,
        projectScoped(scope, { sessionId, intentId }),
      );
    },
  );
}

/**
 * Loads one stored Agent image for display. A missing or unreadable attachment
 * resolves to null rather than throwing: a thumbnail that cannot load must not
 * turn a completed read into a visible failure.
 */
export async function readIrisAgentAttachment(
  sessionId: string,
  attachmentId: string,
): Promise<string | null> {
  const scope = scopeOrThrow();
  const result = await window.api.invoke<
    { sessionId: string; attachmentId: string; expectedScope: ProjectScope },
    IrisAgentAttachmentData
  >(
    CHANNELS.IRIS_AGENT_ATTACHMENT_READ,
    projectScoped(scope, { sessionId, attachmentId }),
  );
  return result.dataUrl;
}

export async function replayIrisAgentTerminal(
  sessionId: string,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<IrisAgentTerminalReplay> {
  const scope = scopeOrThrow();
  return window.api.invoke<{
    sessionId: string;
    terminalId: string;
    cols: number;
    rows: number;
    expectedScope: ProjectScope;
  }, IrisAgentTerminalReplay>(CHANNELS.IRIS_AGENT_TERMINAL_REPLAY, projectScoped(scope, {
    sessionId, terminalId, cols, rows,
  }));
}

export async function writeIrisAgentTerminal(
  sessionId: string,
  terminalId: string,
  data: string,
): Promise<void> {
  const scope = scopeOrThrow();
  await window.api.invoke<{
    sessionId: string;
    terminalId: string;
    data: string;
    expectedScope: ProjectScope;
  }, void>(CHANNELS.IRIS_AGENT_TERMINAL_INPUT, projectScoped(scope, { sessionId, terminalId, data }));
}

export async function resizeIrisAgentTerminal(
  sessionId: string,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  const scope = scopeOrThrow();
  await window.api.invoke<{
    sessionId: string;
    terminalId: string;
    cols: number;
    rows: number;
    expectedScope: ProjectScope;
  }, void>(CHANNELS.IRIS_AGENT_TERMINAL_RESIZE, projectScoped(scope, {
    sessionId, terminalId, cols, rows,
  }));
}

export async function continueIrisAgentTerminalSupervision(
  sessionId: string,
  terminalId: string,
): Promise<void> {
  const scope = scopeOrThrow();
  const session = await window.api.invoke<{
    sessionId: string;
    terminalId: string;
    expectedScope: ProjectScope;
  }, IrisAgentSessionInfo>(CHANNELS.IRIS_AGENT_SUPERVISION_CONTINUE, projectScoped(scope, {
    sessionId, terminalId,
  }));
  irisAgentStore.handleChanged(session);
}

export async function closeIrisAgent(sessionId: string): Promise<SessionCloseOutcome> {
  let userCancelled = false;
  const outcome = await runUserAction(
    {
      title: 'Iris Agent 关闭失败',
      dedupeKey: 'iris-agent:close:' + sessionId,
    },
    async () => {
      const current = irisAgentStore.get().sessions.find((session) => session.id === sessionId);
      if (!current) throw new Error('The Iris Agent session is no longer available.');
      const running = current.state === 'starting' ||
        current.state === 'running' ||
        current.state === 'waiting-tool' ||
        current.state === 'retry-wait' ||
        current.state === 'stopping';
      let confirmBusy = false;
      if (running) {
        const confirmed = await confirmDialog({
          title: '关闭正在运行的 Iris Agent？',
          message: 'Agent 仍在工作。关闭会停止当前任务并结束该实例，对话记录会保留在历史中，可随时重新打开。',
          confirmText: '停止并关闭',
          tone: 'destructive',
        });
        if (!confirmed) {
          userCancelled = true;
          return;
        }
        confirmBusy = true;
      }
      const scope = scopeOrThrow();
      const precondition = commandPrecondition(sessionId);
      await window.api.invoke<{
          sessionId: string;
          commandId: string;
          expectedRevision: number;
          confirmBusy?: boolean;
          expectedScope: ProjectScope;
      }, void>(
        CHANNELS.IRIS_AGENT_CLOSE,
        projectScoped(scope, { sessionId, ...precondition, ...(confirmBusy ? { confirmBusy: true } : {}) }),
      );
      irisAgentStore.handleDestroyed(sessionId);
    },
  );
  return userCancelled ? { status: 'cancelled' } : sessionCloseOutcome(outcome);
}
