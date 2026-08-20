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
import { irisAgentStore } from '@renderer/stores/iris-agent-store';
import { attemptAction, runUserAction } from './action-runtime';
import { notify } from '@renderer/stores/notification-store';
import { confirmDialog } from '@renderer/components/ui/confirm-dialog';

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

function turnPrecondition(sessionId: string): {
  commandId: string;
  expectedRevision: number;
  expectedTurnId: string;
} {
  const session = irisAgentStore.get().sessions.find((candidate) => candidate.id === sessionId);
  if (!session?.currentTurnId) throw new Error('The Iris Agent Turn is no longer available.');
  return { ...commandPrecondition(sessionId), expectedTurnId: session.currentTurnId };
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
    irisAgentStore.select(session.id);
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
  if (!trimmed) return;
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
      const precondition = turnPrecondition(sessionId);
      const session = await window.api.invoke<
        {
          sessionId: string;
          commandId: string;
          expectedRevision: number;
          expectedTurnId: string;
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
    title: '撤销 Iris Agent 上一轮？',
    message: '只撤销最后一轮对话。已发生的文件改动、终端命令和外部副作用不会回滚。',
    confirmText: '撤销上一轮',
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
  throughTurnId: string,
): Promise<IrisAgentSessionInfo | null> {
  const outcome = await attemptAction(async () => {
    const scope = scopeOrThrow();
    const precondition = commandPrecondition(sessionId);
    const session = await window.api.invoke<
      {
        sessionId: string;
        throughTurnId: string;
        commandId: string;
        expectedRevision: number;
        expectedScope: ProjectScope;
      },
      IrisAgentSessionInfo
    >(CHANNELS.IRIS_AGENT_BRANCH, projectScoped(scope, {
      sessionId,
      throughTurnId,
      ...precondition,
    }));
    irisAgentStore.handleChanged(session);
    irisAgentStore.select(session.id);
    return session;
  });
  if (outcome.status === 'ok') return outcome.value;
  if (outcome.status === 'failed') {
    notify({
      dedupeKey: `iris-agent:branch:${sessionId}:${throughTurnId}`,
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

export async function openIrisAgentContext(sessionId: string, turnId: string): Promise<void> {
  await runUserAction(
    {
      title: '上下文 artifact 打开失败',
      dedupeKey: `iris-agent:context:${sessionId}:${turnId}`,
    },
    async () => {
      const scope = scopeOrThrow();
      await window.api.invoke<
        { sessionId: string; turnId: string; expectedScope: ProjectScope },
        void
      >(
        CHANNELS.IRIS_AGENT_OPEN_CONTEXT,
        projectScoped(scope, { sessionId, turnId }),
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

export async function closeIrisAgent(sessionId: string): Promise<void> {
  await runUserAction(
    {
      title: 'Iris Agent 关闭失败',
      dedupeKey: 'iris-agent:close:' + sessionId,
    },
    async () => {
      const scope = scopeOrThrow();
      const precondition = commandPrecondition(sessionId);
      await window.api.invoke<{
        sessionId: string;
        commandId: string;
        expectedRevision: number;
        expectedScope: ProjectScope;
      }, void>(
        CHANNELS.IRIS_AGENT_CLOSE,
        projectScoped(scope, { sessionId, ...precondition }),
      );
      irisAgentStore.handleDestroyed(sessionId);
    },
  );
}
