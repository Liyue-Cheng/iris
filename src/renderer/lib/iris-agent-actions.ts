import { CHANNELS } from '@shared/protocol';
import type {
  IrisAgentAnchor,
  IrisAgentModelCatalog,
  IrisAgentModelRef,
  IrisAgentSessionInfo,
  IrisAgentTerminalReplay,
  ProjectScope,
} from '@shared/types';
import { editorStore } from '@renderer/stores/editor-store';
import { projectStore } from '@renderer/stores/project-store';
import { irisAgentAnchorKey, irisAgentStore } from '@renderer/stores/iris-agent-store';
import { sessionViewStore } from '@renderer/stores/session-view-store';
import { irisAgentSessionKey } from './session-projection';
import { attemptAction, runUserAction } from './action-runtime';
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

export async function openIrisAgent(anchor: IrisAgentAnchor): Promise<IrisAgentSessionInfo | null> {
  const outcome = await attemptAction(async () => {
    if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return null;
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

export async function sendIrisAgentMessage(sessionId: string, message: string): Promise<void> {
  const trimmed = message.trim();
  const session = irisAgentStore.get().sessions.find((candidate) => candidate.id === sessionId);
  const canStartFromDocument = session?.anchor.kind === 'document' && session.intents.length === 0;
  if (!trimmed && !canStartFromDocument) return;
  await runUserAction(
    {
      title: 'Iris Agent 发送失败',
      dedupeKey: 'iris-agent:send:' + sessionId,
    },
    async () => {
      if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return;
      const scope = scopeOrThrow();
      const precondition = commandPrecondition(sessionId);
      const session = await window.api.invoke<
        {
          sessionId: string;
          message: string;
          commandId: string;
          expectedRevision: number;
          expectedScope: ProjectScope;
        },
        IrisAgentSessionInfo
      >(CHANNELS.IRIS_AGENT_SEND, projectScoped(scope, {
        sessionId,
        message: trimmed,
        ...precondition,
      }));
      irisAgentStore.handleChanged(session);
    },
  );
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
          message: 'Agent 仍在工作。关闭会话将停止当前任务并移除该会话。',
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
