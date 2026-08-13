import { CHANNELS } from '@shared/protocol';
import type {
  IrisAgentAnchor,
  IrisAgentSessionInfo,
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
      const session = await window.api.invoke<
        { sessionId: string; message: string; expectedScope: ProjectScope },
        IrisAgentSessionInfo
      >(CHANNELS.IRIS_AGENT_SEND, projectScoped(scope, { sessionId, message: trimmed }));
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
      const session = await window.api.invoke<
        { sessionId: string; expectedScope: ProjectScope },
        IrisAgentSessionInfo
      >(CHANNELS.IRIS_AGENT_STOP, projectScoped(scope, { sessionId }));
      irisAgentStore.handleChanged(session);
    },
  );
}

export async function retryIrisAgent(sessionId: string): Promise<void> {
  await runUserAction(
    {
      title: 'Iris Agent 重试失败',
      dedupeKey: 'iris-agent:retry:' + sessionId,
    },
    async () => {
      if (!(await editorStore.flushBeforeSwitch('before-external-action'))) return;
      const scope = scopeOrThrow();
      const session = await window.api.invoke<
        { sessionId: string; expectedScope: ProjectScope },
        IrisAgentSessionInfo
      >(CHANNELS.IRIS_AGENT_RETRY, projectScoped(scope, { sessionId }));
      irisAgentStore.handleChanged(session);
    },
  );
}

export async function rewindIrisAgent(sessionId: string, turnId: string): Promise<void> {
  const confirmed = await confirmDialog({
    title: '回退 Iris Agent 消息记录？',
    message: '只回退消息记录，工作区文件、终端输出和外部副作用保持不变。下一次发送会重新读取当前工作区。',
    confirmText: '回退消息',
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
      const session = await window.api.invoke<
        { sessionId: string; turnId: string; expectedScope: ProjectScope },
        IrisAgentSessionInfo
      >(CHANNELS.IRIS_AGENT_REWIND, projectScoped(scope, { sessionId, turnId }));
      irisAgentStore.handleChanged(session);
    },
  );
}

export async function closeIrisAgent(sessionId: string): Promise<void> {
  await runUserAction(
    {
      title: 'Iris Agent 关闭失败',
      dedupeKey: 'iris-agent:close:' + sessionId,
    },
    async () => {
      const scope = scopeOrThrow();
      await window.api.invoke<{ sessionId: string; expectedScope: ProjectScope }, void>(
        CHANNELS.IRIS_AGENT_CLOSE,
        projectScoped(scope, { sessionId }),
      );
      irisAgentStore.handleDestroyed(sessionId);
    },
  );
}
