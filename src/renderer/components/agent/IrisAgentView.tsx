import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Bot,
  BotMessageSquare,
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  FileText,
  FolderSearch,
  GitBranch,
  LoaderCircle,
  RotateCcw,
  Send,
  Square,
  SquareTerminal,
  Undo2,
  X,
} from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  IrisAgentCardState,
  IrisAgentCardView,
  IrisAgentModelOption,
  IrisAgentSessionInfo,
  IrisAgentUserView,
  IrisAgentTerminalOutputPayload,
  IrisAgentTerminalView,
} from '@shared/types';
import { EVENTS } from '@shared/protocol';
import { Button } from '@renderer/components/ui/button';
import {
  branchIrisAgent,
  listIrisAgentModels,
  resumeIrisAgent,
  rewindIrisAgent,
  openIrisAgentContext,
  sendIrisAgentMessage,
  setIrisAgentModel,
  stopIrisAgent,
  replayIrisAgentTerminal,
  resizeIrisAgentTerminal,
  writeIrisAgentTerminal,
  continueIrisAgentTerminalSupervision,
} from '@renderer/lib/iris-agent-actions';
import { BrowserXtermAdapter } from '@renderer/terminal/xterm-adapter';
import { getSettings } from '@renderer/stores/settings-store';

export function IrisAgentView({
  session,
  onForked,
}: {
  session: IrisAgentSessionInfo;
  onForked?: (session: IrisAgentSessionInfo) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [models, setModels] = useState<IrisAgentModelOption[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);
  const [hiddenTerminalIds, setHiddenTerminalIds] = useState<Set<string>>(() => new Set());
  const knownTerminalIds = useRef(new Set(session.terminals.map((terminal) => terminal.id)));
  const modelRequest = useRef(0);
  const autoSelectingModel = useRef<string | null>(null);
  const running = isSessionRunning(session);
  const statusText = statusLabel(session.state);
  const visibleTerminals = session.terminals.filter((terminal) =>
    !hiddenTerminalIds.has(terminal.id) &&
    (terminal.revealed || terminal.id === selectedTerminalId));
  const selectedTerminal = visibleTerminals.find((terminal) => terminal.id === selectedTerminalId) ?? null;

  useEffect(() => {
    const added = session.terminals.find((terminal) => !knownTerminalIds.current.has(terminal.id));
    for (const terminal of session.terminals) knownTerminalIds.current.add(terminal.id);
    if (added?.revealed) {
      setHiddenTerminalIds((current) => {
        const next = new Set(current);
        next.delete(added.id);
        return next;
      });
      setSelectedTerminalId(added.id);
    }
  }, [session.terminals]);

  const refreshModels = useCallback((forceRefresh = false): void => {
    const request = ++modelRequest.current;
    setModelsLoading(true);
    void listIrisAgentModels(forceRefresh).then((catalog) => {
      if (modelRequest.current !== request) return;
      setModels(catalog.models);
      setModelError(catalog.error ?? null);
    }).catch((error: unknown) => {
        if (modelRequest.current !== request) return;
        setModels([]);
        setModelError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (modelRequest.current === request) setModelsLoading(false);
    });
  }, []);

  useEffect(() => {
    const unsubscribe = window.api.on(EVENTS.IRIS_AGENT_PROVIDERS_CHANGED, () => refreshModels(true));
    refreshModels();
    return () => {
      modelRequest.current += 1;
      unsubscribe();
    };
  }, [refreshModels]);

  const selectedModelValue = session.model
    ? modelValue(session.model.provider, session.model.modelId)
    : '';
  const selectedModelAvailable = session.model
    ? models.some(
        (model) =>
          model.provider === session.model?.provider && model.modelId === session.model.modelId,
      )
    : false;

  useEffect(() => {
    if (session.model && selectedModelAvailable) {
      autoSelectingModel.current = null;
      return;
    }
    // A fresh session may carry a remembered model whose provider is currently
    // unavailable. Fall back only before the session has any conversation history.
    if (session.model && session.turns.length > 0) return;
    const first = models[0];
    if (modelsLoading || !first) return;
    const key = modelValue(first.provider, first.modelId);
    if (autoSelectingModel.current === key) return;
    autoSelectingModel.current = key;
    void setIrisAgentModel(session.id, {
      provider: first.provider,
      modelId: first.modelId,
    }).catch((error: unknown) => {
      autoSelectingModel.current = null;
      setModelError(error instanceof Error ? error.message : String(error));
    });
  }, [models, modelsLoading, selectedModelAvailable, session.id, session.model, session.turns.length]);
  const openContext = (turnId: string): void => {
    openIrisAgentContext(session.id, turnId).catch(() => undefined);
  };

  const submitDraft = (): void => {
    if (running) {
      void stopIrisAgent(session.id);
      return;
    }
    if (draft.trim() === '' || !selectedModelAvailable) return;
    const text = draft;
    setDraft('');
    void sendIrisAgentMessage(session.id, text);
  };

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
        <select
          value={selectedModelValue}
          disabled={running || models.length === 0}
          aria-label="Provider and model"
          title={modelError ?? 'Provider and model'}
          className="h-7 w-40 max-w-[40%] min-w-0 shrink rounded border border-border bg-background px-1.5 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
          onChange={(event) => {
            const model = models.find(
              (candidate) => modelValue(candidate.provider, candidate.modelId) === event.target.value,
            );
            if (model) {
              setIrisAgentModel(session.id, {
                provider: model.provider,
                modelId: model.modelId,
              }).catch(() => undefined);
            }
          }}
        >
          {!session.model && (
            <option value="" disabled>
              {modelsLoading
                ? '正在加载模型…'
                : modelError && models.length === 0
                  ? '模型加载失败'
                  : '选择模型'}
            </option>
          )}
          {session.model && !selectedModelAvailable && (
            <option value={selectedModelValue} disabled>
              {session.model.provider}/{session.model.modelId}（不可用）
            </option>
          )}
          {models.map((model) => (
            <option
              key={modelValue(model.provider, model.modelId)}
              value={modelValue(model.provider, model.modelId)}
            >
              {model.providerName ?? model.provider}/{model.name}
            </option>
          ))}
        </select>
        {!running && session.canUndoLatestTurn && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => void rewindIrisAgent(session.id)}
            title="只撤销最后一轮对话，工作区保持不变"
            aria-label="撤销上一轮"
          >
            <Undo2 className="!size-3.5" />
          </Button>
        )}
      </div>

      {modelError && (
        <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {models.length > 0 ? '部分供应商模型加载失败' : '模型加载失败'}
            </div>
            <div className="mt-0.5 max-h-20 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
              {modelError}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            disabled={modelsLoading}
            title="重新加载模型"
            aria-label="重新加载模型"
            onClick={() => refreshModels(true)}
          >
            <RotateCcw className={`!size-3.5 ${modelsLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      )}

      {visibleTerminals.length > 0 && (
        <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b bg-muted/30 px-2 pt-1">
          <button
            type="button"
            className={`h-8 shrink-0 border-b-2 px-3 text-xs ${selectedTerminal ? 'border-transparent text-muted-foreground' : 'border-primary text-foreground'}`}
            onClick={() => setSelectedTerminalId(null)}
          >
            Agent
          </button>
          {visibleTerminals.map((terminal) => (
            <button
              key={terminal.id}
              type="button"
              className={`flex h-8 max-w-48 shrink-0 items-center gap-1.5 border-b-2 px-2 text-xs ${selectedTerminal?.id === terminal.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'}`}
              onClick={() => setSelectedTerminalId(terminal.id)}
            >
              <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{terminalTitle(terminal)}</span>
              {terminal.state === 'exited' && (
                <span
                  role="button"
                  tabIndex={0}
                  title="关闭终端工作面"
                  aria-label="关闭终端工作面"
                  className="ml-0.5 rounded p-0.5 hover:bg-muted"
                  onClick={(event) => {
                    event.stopPropagation();
                    setHiddenTerminalIds((current) => new Set(current).add(terminal.id));
                    if (selectedTerminalId === terminal.id) setSelectedTerminalId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    setHiddenTerminalIds((current) => new Set(current).add(terminal.id));
                    if (selectedTerminalId === terminal.id) setSelectedTerminalId(null);
                  }}
                >
                  <X className="h-3 w-3" />
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {session.supervisionAlert && (
        <div className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">终端输出可能异常，进程仍在运行</div>
              <div className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
                {session.supervisionAlert.evidence}
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 bg-background"
                  onClick={() => void continueIrisAgentTerminalSupervision(
                    session.id, session.supervisionAlert!.terminalId,
                  ).catch(() => undefined)}
                >
                  继续观察
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="h-7"
                  onClick={() => void stopIrisAgent(session.id)}
                >
                  终止命令
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedTerminal ? (
        <AgentTerminalPane sessionId={session.id} terminal={selectedTerminal} />
      ) : (
        <>

      {session.pause && (
        <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {session.pause.reason === 'user' ? '已停止' : '请求已暂停'}
            </div>
            {session.pause.reason !== 'user' && (
              <div className="mt-0.5 break-words text-muted-foreground">{session.pause.message}</div>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 bg-background"
            onClick={() => void resumeIrisAgent(session.id)}
          >
            <RotateCcw className="!size-3.5" />
            继续
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {session.turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <Bot className="h-9 w-9 text-muted-foreground/40" />
            <p>已固定当前 anchor。发送消息前会重新读取最新内容。</p>
          </div>
        ) : (
          <div className="space-y-4">
            {session.turns.map((turn) => {
              return (
                <div key={turn.id} className="space-y-2">
                  <UserMessage
                    message={turn.user}
                    onOpenPrompt={turn.user.contextAvailable ? () => openContext(turn.id) : undefined}
                    artifactTitle={turn.user.contextTitle}
                  />
                  {turn.cards.map((card) => (
                    <AgentActivityCard
                      key={card.id}
                      card={card}
                      canRetry={false}
                      onRetry={() => undefined}
                      onOpenTerminal={(terminalId) => {
                        setHiddenTerminalIds((current) => {
                          const next = new Set(current);
                          next.delete(terminalId);
                          return next;
                        });
                        setSelectedTerminalId(terminalId);
                      }}
                    />
                  ))}
                  {turn.canFork && (
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground"
                        title="从本轮创建对话分支"
                        aria-label="从本轮创建对话分支"
                        onClick={() => {
                          branchIrisAgent(session.id, turn.id).then((forked) => {
                            if (forked) onForked?.(forked);
                          }).catch(() => undefined);
                        }}
                      >
                        <GitBranch className="!size-3.5" />
                      </Button>
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
          submitDraft();
        }}
      >
        <div className="flex gap-2">
          <textarea
            value={draft}
            disabled={running}
            rows={2}
            className="min-h-10 flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
            placeholder={running
              ? 'Iris Agent 正在工作…'
              : selectedModelAvailable
                ? '输入给 Iris Agent 的任务'
                : '先选择可用模型'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitDraft();
              }
            }}
          />
          <Button
            type="submit"
            size="icon"
            disabled={running ? false : !selectedModelAvailable || draft.trim() === ''}
            title={running ? '停止' : '发送'}
            aria-label={running ? '停止' : '发送'}
          >
            {running ? <Square className="!size-4" /> : <Send className="!size-4" />}
          </Button>
        </div>
      </form>
        </>
      )}
    </div>
  );
}

function AgentTerminalPane({
  sessionId,
  terminal,
}: {
  sessionId: string;
  terminal: IrisAgentTerminalView;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const settings = getSettings();
    const adapter = new BrowserXtermAdapter({
      fontFamily: settings?.appearance.terminalFontFamily ?? "'Cascadia Mono', 'Consolas', monospace",
      fontSize: settings?.appearance.terminalFontSize ?? 13,
      lineHeight: settings?.appearance.terminalLineHeight ?? 1.2,
      themeId: settings?.appearance.theme,
      renderer: settings?.advanced.terminalRenderer ?? 'auto',
      windowsBuild: window.api.windowsBuild,
      openLink: () => undefined,
    });
    adapter.open(host);
    const term = adapter.terminal;
    adapter.fit.fit();
    let disposed = false;
    let replayed = false;
    let replayCursor = 0;
    const queued: IrisAgentTerminalOutputPayload[] = [];
    const unsubscribe = window.api.on<IrisAgentTerminalOutputPayload>(
      EVENTS.IRIS_AGENT_TERMINAL_OUTPUT,
      (payload) => {
        if (payload.sessionId !== sessionId || payload.terminalId !== terminal.id) return;
        if (!replayed) {
          queued.push(payload);
          return;
        }
        if (payload.cursor >= replayCursor) term.write(decodeBase64(payload.data));
      },
    );
    const dataDisposable = term.onData((data) => {
      void writeIrisAgentTerminal(sessionId, terminal.id, data).catch(() => undefined);
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (cols < 20 || rows < 5) return;
      void resizeIrisAgentTerminal(sessionId, terminal.id, cols, rows).catch(() => undefined);
    });
    const observer = new ResizeObserver(() => adapter.fit.fit());
    observer.observe(host);
    void replayIrisAgentTerminal(sessionId, terminal.id, term.cols, term.rows).then((snapshot) => {
      if (disposed) return;
      replayCursor = snapshot.cursor;
      term.write(decodeBase64(snapshot.data), () => {
        if (disposed) return;
        replayed = true;
        for (const payload of queued) {
          if (payload.cursor >= replayCursor) term.write(decodeBase64(payload.data));
        }
        queued.length = 0;
        term.scrollToBottom();
        term.focus();
      });
    }).catch((error: unknown) => {
      if (!disposed) term.writeln(`\r\nUnable to replay terminal: ${error instanceof Error ? error.message : String(error)}`);
      replayed = true;
      replayCursor = 0;
      for (const payload of queued) term.write(decodeBase64(payload.data));
      queued.length = 0;
    });
    return () => {
      disposed = true;
      observer.disconnect();
      unsubscribe();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      adapter.dispose();
    };
  }, [sessionId, terminal.id]);

  return <div ref={hostRef} className="min-h-0 flex-1 bg-black p-1" />;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function terminalTitle(terminal: IrisAgentTerminalView): string {
  const first = terminal.command.trim().split(/\s+/u)[0] ?? 'Terminal';
  return `${first}${terminal.state === 'running' ? ' · 运行中' : ''}`;
}

function AgentActivityCard({
  card,
  canRetry,
  onRetry,
  onOpenTerminal,
}: {
  card: IrisAgentCardView;
  canRetry: boolean;
  onRetry: () => void;
  onOpenTerminal: (terminalId: string) => void;
}): JSX.Element {
  switch (card.kind) {
    case 'local-retrieval':
      return <LocalRetrievalCard card={card} onOpenTerminal={onOpenTerminal} />;
    case 'file-change':
      return <FileChangeCard card={card} />;
    case 'terminal-operation':
      return <TerminalOperationCard card={card} onOpenTerminal={onOpenTerminal} />;
    case 'agent-reply':
      return <AgentReplyCard card={card} canRetry={canRetry} onRetry={onRetry} />;
  }
}

function LocalRetrievalCard({
  card,
  onOpenTerminal,
}: {
  card: Extract<IrisAgentCardView, { kind: 'local-retrieval' }>;
  onOpenTerminal: (terminalId: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const files = card.items.filter((item) => item.kind === 'file').length;
  const queries = card.items.length - files;
  const failed = card.items.filter((item) => item.state === 'failed').length;
  const visibleItems = expanded ? card.items : card.items.slice(-5);
  const summary = card.state === 'running'
    ? '正在获取本地信息'
    : [files > 0 ? `${files} 个文件` : '', queries > 0 ? `${queries} 条查询` : '']
        .filter(Boolean)
        .join(' · ');
  return (
    <CardFrame
      icon={<FolderSearch className="h-4 w-4" />}
      title="本地获取"
      summary={failed > 0 ? `${summary} · ${failed} 项失败` : summary}
      state={card.state}
      action={card.items.length > 5 ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title={expanded ? '收起获取记录' : '展开全部获取记录'}
          aria-label={expanded ? '收起获取记录' : '展开全部获取记录'}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="!size-3.5" /> : <ChevronRight className="!size-3.5" />}
        </Button>
      ) : undefined}
    >
      <div className="divide-y divide-border/60">
        {!expanded && card.items.length > 5 && (
          <div className="px-3 py-1.5 text-[11px] text-muted-foreground">
            另有 {card.items.length - 5} 项
          </div>
        )}
        {visibleItems.map((item) => (
          <div key={item.id} className="min-w-0 px-3 py-2 text-xs">
            <div className="flex min-w-0 items-start gap-2">
              {item.kind === 'file'
                ? <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                : <SquareTerminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <div className="break-all font-mono text-[11px] text-foreground/90">{item.label}</div>
                <div className={`mt-0.5 flex items-center gap-1 text-[11px] ${item.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
                  <RetrievalStateIcon state={item.state} />
                  <span>{retrievalStateLabel(item.state)}</span>
                </div>
                {item.state === 'failed' && item.error && (
                  <details className="mt-1 text-[11px] text-destructive">
                    <summary className="cursor-pointer select-none">展开失败原因</summary>
                    <div className="mt-1 whitespace-pre-wrap break-words">{item.error}</div>
                    {item.errorDetail && (
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-destructive/20 bg-background p-2 font-mono text-[10px] text-foreground">
                        {item.errorDetail}
                      </pre>
                    )}
                    {item.terminalId && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="mt-1 h-6 px-1.5 text-[11px]"
                        onClick={() => onOpenTerminal(item.terminalId!)}
                      >
                        <SquareTerminal className="!size-3" />
                        打开终端
                      </Button>
                    )}
                  </details>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </CardFrame>
  );
}

function FileChangeCard({
  card,
}: {
  card: Extract<IrisAgentCardView, { kind: 'file-change' }>;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const lines = card.diff?.split('\n') ?? [];
  const stats = diffStats(lines);
  const long = lines.length > 24;
  const verb = card.action === 'created'
    ? '创建'
    : card.action === 'updated'
      ? '修改'
      : card.action === 'unchanged'
        ? '未改变'
        : '尝试写入';
  return (
    <CardFrame
      icon={<FileDiff className="h-4 w-4" />}
      title="文件写入"
      summary={`${verb} ${card.path}${stats ? ` · ${stats}` : ''}`}
      state={card.state}
      action={long ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title={expanded ? '收起 diff' : '展开完整 diff'}
          aria-label={expanded ? '收起 diff' : '展开完整 diff'}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="!size-3.5" /> : <ChevronRight className="!size-3.5" />}
        </Button>
      ) : undefined}
    >
      {card.diff ? (
        <pre
          className={`${expanded ? 'max-h-none' : 'max-h-72'} overflow-auto border-t bg-background/70 p-2 font-mono text-[11px] leading-5`}
          aria-label={`文件差异 ${card.path}`}
        >
          {lines.map((line, index) => (
            <span key={`${index}:${line}`} className={`${diffLineClass(line)} block min-w-max whitespace-pre`}>
              {line || ' '}
            </span>
          ))}
        </pre>
      ) : (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          {card.error ?? (card.action === 'unchanged' ? '内容与现有文件一致。' : card.detail)}
        </div>
      )}
      {card.error && card.diff && (
        <div className="border-t border-destructive/30 px-3 py-2 text-xs text-destructive">
          {card.error}
        </div>
      )}
    </CardFrame>
  );
}

function TerminalOperationCard({
  card,
  onOpenTerminal,
}: {
  card: Extract<IrisAgentCardView, { kind: 'terminal-operation' }>;
  onOpenTerminal: (terminalId: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const multiline = card.command.split('\n').length > 6 || card.command.length > 420;
  return (
    <CardFrame
      icon={<SquareTerminal className="h-4 w-4" />}
      title="操作终端"
      summary={cardStateLabel(card.state)}
      state={card.state}
      action={multiline ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title={expanded ? '收起命令' : '展开完整命令'}
          aria-label={expanded ? '收起命令' : '展开完整命令'}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="!size-3.5" /> : <ChevronRight className="!size-3.5" />}
        </Button>
      ) : undefined}
    >
      <pre
        className={`${expanded ? 'max-h-none' : 'max-h-40'} overflow-auto border-t bg-background/70 p-3 whitespace-pre-wrap break-words font-mono text-xs leading-5`}
        aria-label="执行命令"
      >
        {card.command}
      </pre>
      {card.error && (
        <details className="border-t border-destructive/30 px-3 py-2 text-xs text-destructive">
          <summary className="cursor-pointer select-none">展开失败原因</summary>
          <div className="mt-1 whitespace-pre-wrap break-words">{card.error}</div>
          {card.errorDetail && (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-destructive/20 bg-background p-2 font-mono text-[10px] text-foreground">
              {card.errorDetail}
            </pre>
          )}
        </details>
      )}
      {card.terminalId && (
        <div className="flex justify-end border-t px-2 py-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="打开终端"
            aria-label="打开终端"
            onClick={() => onOpenTerminal(card.terminalId!)}
          >
            <SquareTerminal className="!size-3.5" />
          </Button>
        </div>
      )}
    </CardFrame>
  );
}

function AgentReplyCard({
  card,
  canRetry,
  onRetry,
}: {
  card: Extract<IrisAgentCardView, { kind: 'agent-reply' }>;
  canRetry: boolean;
  onRetry: () => void;
}): JSX.Element {
  const placeholder = card.state === 'stopped' ? '本轮已暂停。' : '正在回复…';
  return (
    <CardFrame
      icon={<BotMessageSquare className="h-4 w-4" />}
      title="Agent 回复"
      summary={card.state === 'running'
        ? '正在回复'
        : card.state === 'stopped'
          ? card.excludedFromContext ? '已暂停 · 未进入上下文' : '已暂停'
          : card.excludedFromContext
            ? '未进入上下文'
            : '已回复'}
      state={card.state}
    >
      <div className="markdown-body min-w-0 border-t px-3 py-2.5 text-sm">
        {card.content
          ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.content}</ReactMarkdown>
          : <span className="text-muted-foreground">{placeholder}</span>}
      </div>
      {card.error && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <div className="flex items-start gap-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-pre-wrap break-words">{card.error}</span>
          </div>
          {canRetry && (
            <div className="mt-2 flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-destructive/40 bg-background text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={onRetry}
              >
                <RotateCcw className="!size-3.5" />
                重试
              </Button>
            </div>
          )}
        </div>
      )}
    </CardFrame>
  );
}

function CardFrame({
  icon,
  title,
  summary,
  state,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  summary?: string;
  state: IrisAgentCardState;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="overflow-hidden rounded-md border border-border/80 bg-card" aria-label={title}>
      <div className="flex min-h-9 items-center gap-2 px-3 py-1.5">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="shrink-0 text-xs font-medium">{title}</h3>
            {summary && (
              <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={summary}>
                {summary}
              </span>
            )}
          </div>
        </div>
        <CardStateIcon state={state} />
        {action}
      </div>
      {children}
    </section>
  );
}

function CardStateIcon({ state }: { state: IrisAgentCardState }): JSX.Element {
  if (state === 'running') {
    return <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="运行中" />;
  }
  if (state === 'failed') {
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="失败" />;
  }
  if (state === 'partial') {
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-label="部分失败" />;
  }
  if (state === 'stopped') {
    return <Square className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="已停止" />;
  }
  return <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={state === 'unchanged' ? '无变化' : '完成'} />;
}

function RetrievalStateIcon({
  state,
}: {
  state: 'running' | 'completed' | 'failed' | 'canceled';
}): JSX.Element {
  if (state === 'running') return <LoaderCircle className="h-3 w-3 animate-spin" />;
  if (state === 'failed') return <AlertTriangle className="h-3 w-3" />;
  if (state === 'canceled') return <Square className="h-2.5 w-2.5" />;
  return <Check className="h-3 w-3" />;
}

function retrievalStateLabel(state: 'running' | 'completed' | 'failed' | 'canceled'): string {
  if (state === 'running') return '运行中';
  if (state === 'failed') return '失败';
  if (state === 'canceled') return '已停止';
  return '成功';
}

function cardStateLabel(state: IrisAgentCardState): string {
  if (state === 'running') return '运行中';
  if (state === 'failed') return '失败';
  if (state === 'stopped') return '已停止';
  return '成功';
}

function UserMessage({
  message,
  onOpenPrompt,
  artifactTitle,
}: {
  message: IrisAgentUserView;
  onOpenPrompt: (() => void) | undefined;
  artifactTitle: string | undefined;
}): JSX.Element {
  return (
    <div className="rounded-md bg-muted px-3 py-2 text-sm">
      <div className="mb-1 flex h-6 items-start justify-between gap-2">
        <span className="text-[11px] font-medium uppercase text-muted-foreground">You</span>
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
      <div className="whitespace-pre-wrap break-words">{message.content}</div>
    </div>
  );
}

function diffStats(lines: string[]): string {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return additions > 0 || deletions > 0 ? `+${additions} -${deletions}` : '';
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted-foreground';
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-700 dark:text-red-300';
  if (line.startsWith('@@')) return 'bg-muted/60 text-muted-foreground';
  return 'text-foreground/80';
}

function isSessionRunning(session: IrisAgentSessionInfo): boolean {
  return session.state === 'starting' ||
    session.state === 'running' ||
    session.state === 'waiting-tool' ||
    session.state === 'retry-wait' ||
    session.state === 'stopping';
}

function modelValue(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
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
    case 'retry-wait':
      return '等待重试';
    case 'stopping':
      return '停止中';
    case 'paused':
      return '已暂停';
    case 'idle':
      return '空闲';
  }
}
