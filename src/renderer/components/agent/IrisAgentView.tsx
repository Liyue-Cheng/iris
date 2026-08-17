import { useMemo, useState } from 'react';
import { AlertTriangle, Bot, FileText, RotateCcw, Send, Square, Undo2 } from 'lucide-react';
import type { IrisAgentMessage, IrisAgentSessionInfo } from '@shared/types';
import { Button } from '@renderer/components/ui/button';
import {
  retryIrisAgent,
  rewindIrisAgent,
  openIrisAgentContext,
  sendIrisAgentMessage,
  stopIrisAgent,
} from '@renderer/lib/iris-agent-actions';

export function IrisAgentView({ session }: { session: IrisAgentSessionInfo }): JSX.Element {
  const [draft, setDraft] = useState('');
  const running =
    session.state === 'starting' ||
    session.state === 'running' ||
    session.state === 'waiting-tool' ||
    session.state === 'stopping';
  const latestTurn = session.turns[session.turns.length - 1] ?? null;
  const latestRetryableTurn =
    latestTurn?.status === 'failed' || latestTurn?.status === 'stopped' ? latestTurn : null;
  const canUndoLatestTurn = latestTurn !== null && latestTurn.status !== 'running';
  const statusText = statusLabel(session.state);
  const openContext = (turnId: string): void => {
    openIrisAgentContext(session.id, turnId).catch(() => undefined);
  };
  const toolEventsByTurn = useMemo(() => {
    const map = new Map<string, typeof session.toolEvents>();
    for (const event of session.toolEvents) {
      const events = map.get(event.turnId) ?? [];
      events.push(event);
      map.set(event.turnId, events);
    }
    return map;
  }, [session.toolEvents]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Bot className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">Iris Agent</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {statusText} · 当前版本尚不具备自举资格
          </div>
        </div>
        {running ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={() => void stopIrisAgent(session.id)}
          >
            <Square className="!size-3.5" />
            停止
          </Button>
        ) : latestRetryableTurn ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={() => void retryIrisAgent(session.id)}
          >
            <RotateCcw className="!size-3.5" />
            重试
          </Button>
        ) : null}
        {!running && canUndoLatestTurn && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={() => void rewindIrisAgent(session.id)}
            title="只撤销最后一轮对话，工作区保持不变"
          >
            <Undo2 className="!size-3.5" />
            撤销上一轮
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {session.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <Bot className="h-9 w-9 text-muted-foreground/40" />
            <p>已固定当前 anchor。发送消息前会重新读取最新内容。</p>
          </div>
        ) : (
          <div className="space-y-3">
            {session.turns.map((turn) => {
              const messages = session.messages.filter((message) => message.turnId === turn.id);
              const userMessages = messages.filter((message) => message.role === 'user');
              const assistantMessages = messages.filter(
                (message) => message.role === 'assistant' && !message.providerOnly,
              );
              const tools = toolEventsByTurn.get(turn.id) ?? [];
              const artifactTitle = turn.providerContextAvailable
                ? `打开实际 Provider 上下文（${turn.providerCallCount ?? 1} 次调用）`
                : turn.assembledInputLegacy || turn.promptAvailable
                  ? '打开组装输入（旧版）'
                  : turn.assembledInputAvailable
                    ? '打开本轮组装输入'
                    : undefined;
              return (
                <div key={turn.id} className="space-y-2">
                  {userMessages.map((message) => (
                    <AgentMessageCard
                      key={message.id}
                      message={message}
                      running={running}
                      onOpenPrompt={artifactTitle
                        ? () => openContext(turn.id)
                        : undefined}
                      artifactTitle={artifactTitle}
                    />
                  ))}
                  {tools.length > 0 && (
                    <div className="space-y-1">
                      {tools.map((tool) => (
                        <div
                          key={tool.id}
                          className="rounded border border-border/70 bg-muted/30 px-2 py-1.5 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{tool.name}</span>
                            <span className="text-muted-foreground">{tool.state}</span>
                            {tool.path && <span className="min-w-0 truncate text-muted-foreground">{tool.path}</span>}
                          </div>
                          <div className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                            {tool.error ?? tool.resultSummary ?? tool.inputSummary}
                          </div>
                          {tool.diff && (
                            <pre className="mt-1 max-h-28 overflow-auto rounded bg-background p-2 text-[11px]">
                              {tool.diff}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {assistantMessages.map((message) => (
                    <AgentMessageCard
                      key={message.id}
                      message={message}
                      running={running}
                      onOpenPrompt={artifactTitle
                        ? () => openContext(turn.id)
                        : undefined}
                      artifactTitle={artifactTitle}
                    />
                  ))}
                  {turn.error && (
                    <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="whitespace-pre-wrap break-words">{turn.error}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <form
        className="shrink-0 border-t p-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft;
          setDraft('');
          void sendIrisAgentMessage(session.id, text);
        }}
      >
        <div className="flex gap-2">
          <textarea
            value={draft}
            disabled={running}
            rows={2}
            className="min-h-10 flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
            placeholder={running ? 'Iris Agent 正在工作…' : '输入给 Iris Agent 的任务'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                const text = draft;
                setDraft('');
                void sendIrisAgentMessage(session.id, text);
              }
            }}
          />
          <Button type="submit" size="icon" disabled={running || draft.trim() === ''} title="发送">
            <Send className="!size-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}

function AgentMessageCard({
  message,
  running,
  onOpenPrompt,
  artifactTitle,
}: {
  message: IrisAgentMessage;
  running: boolean;
  onOpenPrompt: (() => void) | undefined;
  artifactTitle: string | undefined;
}): JSX.Element {
  return (
    <div
      className={
        message.role === 'user'
          ? 'rounded-md bg-muted px-3 py-2 text-sm'
          : 'rounded-md border bg-card px-3 py-2 text-sm'
      }
    >
      <div className="mb-1 flex h-6 items-start justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {message.role === 'user' ? 'You' : 'Iris Agent'}
        </span>
        {onOpenPrompt && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mr-1 -mt-1 h-6 w-6 shrink-0 text-muted-foreground"
            title={artifactTitle}
            aria-label={artifactTitle}
            onClick={onOpenPrompt}
          >
            <FileText className="!size-3.5" />
          </Button>
        )}
      </div>
      <div className="whitespace-pre-wrap break-words">
        {message.content || (message.role === 'assistant' && running ? 'Thinking…' : '')}
      </div>
    </div>
  );
}

function statusLabel(state: IrisAgentSessionInfo['state']): string {
  switch (state) {
    case 'starting':
      return '启动中';
    case 'ready':
      return '就绪';
    case 'running':
      return '生成中';
    case 'waiting-tool':
      return '工具执行中';
    case 'stopping':
      return '停止中';
    case 'failed':
      return '失败';
    case 'idle':
      return '空闲';
  }
}
