import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  Play,
  RotateCcw,
  Send,
  Square,
  SquareTerminal,
  Undo2,
  UserRound,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  IrisAgentCardState,
  IrisAgentCardView,
  IrisAgentModelOption,
  IrisAgentSessionInfo,
  IrisAgentUserView,
  IrisAgentTerminalView,
} from '@shared/types';
import { EVENTS } from '@shared/protocol';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import {
  branchIrisAgent,
  listIrisAgentModels,
  resumeIrisAgent,
  rewindIrisAgent,
  openIrisAgentContext,
  sendIrisAgentMessage,
  setIrisAgentModel,
  stopIrisAgent,
  getIrisAgentTask,
  cancelIrisAgentTask,
  continueIrisAgentTerminalSupervision,
} from '@renderer/lib/iris-agent-actions';
import { AgentTerminalDialog } from '@renderer/components/agent/AgentTerminalDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { TextEditContextMenu } from '@renderer/components/ui/text-edit-context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { agentContextBudgetForModel } from '@shared/agent-context-budget';
import { irisAgentSessionKey } from '@renderer/lib/session-projection';
import { AgentContextRing } from '@renderer/components/agent/AgentContextRing';
import {
  contextBudgetTitle,
  contextUsageLabel,
  contextUsageTitle,
  contextUsageTone,
  formatTokenCount,
} from '@renderer/lib/agent-context-usage';
import { SessionViewportController } from '@renderer/lib/session-viewport';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

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
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [openTerminalId, setOpenTerminalId] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const modelRequest = useRef(0);
  const autoSelectingModel = useRef<string | null>(null);
  const running = isSessionRunning(session);
  const statusText = statusLabel(session.state);
  // Only terminals that crossed the display threshold get a workspace entry;
  // short commands stay reachable from their card's output button.
  const terminalWorkspaces = session.terminals.filter((terminal) => terminal.revealed);
  const openTerminal = session.terminals.find((terminal) => terminal.id === openTerminalId) ?? null;

  // Restore the Session viewport before the first paint and keep its bottom
  // anchor stable while Markdown/cards change their measured height.
  useIsomorphicLayoutEffect(() => {
    const viewport = messagesRef.current;
    const content = messagesContentRef.current;
    if (!viewport || !content) return;
    const controller = new SessionViewportController(
      irisAgentSessionKey(session.id),
      viewport,
      content,
    );
    return () => controller.dispose();
  }, [session.id]);

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
    const unsubscribe = window.api.on(EVENTS.IRIS_AGENT_PROVIDERS_CHANGED, () => refreshModels());
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
    if (session.model && session.intents.length > 0) return;
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
  }, [models, modelsLoading, selectedModelAvailable, session.id, session.model, session.intents.length]);
  const openContext = (intentId: string): void => {
    openIrisAgentContext(session.id, intentId).catch(() => undefined);
  };

  const submitDraft = (): void => {
    if (running) {
      void stopIrisAgent(session.id);
      return;
    }
    const canStartFromDocument = session.anchor.kind === 'document' && session.intents.length === 0;
    if (draft.trim() === '' && !canStartFromDocument) return;
    if (!selectedModelAvailable) return;
    const text = draft;
    setDraft('');
    void sendIrisAgentMessage(session.id, text);
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <Dialog open={showErrorDialog} onOpenChange={setShowErrorDialog}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              {models.length > 0 ? '部分供应商模型加载失败' : '模型加载失败'}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-4 max-h-96 overflow-auto rounded-md bg-muted/50 p-3 text-xs">
            <pre className="whitespace-pre-wrap break-words font-mono text-muted-foreground">
              {modelError}
            </pre>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setShowErrorDialog(false)}
            >
              关闭
            </Button>
            <Button
              variant="default"
              disabled={modelsLoading}
              onClick={() => {
                refreshModels(true);
                setShowErrorDialog(false);
              }}
            >
              {modelsLoading ? (
                <>
                  <RotateCcw className="mr-2 h-4 w-4 animate-spin" />
                  重新加载中…
                </>
              ) : (
                <>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  重新加载
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-card/60 px-3">
        <span
          className="iris-agent-avatar flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
          data-running={running || undefined}
        >
          <Bot className="h-4 w-4" />
          {running && <span className="iris-agent-avatar-orbit" aria-hidden="true"><span /></span>}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">Iris Agent</div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="truncate">{statusText}</span>
            {running && (
              <span className="iris-agent-working-dots iris-agent-working-dots-compact shrink-0" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            )}
          </div>
        </div>
        {terminalWorkspaces.length > 0 && (
          <TerminalLauncher terminals={terminalWorkspaces} onOpen={setOpenTerminalId} />
        )}
        {modelError && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={models.length > 0 ? '部分供应商模型加载失败，点击查看详情' : '模型加载失败，点击查看详情'}
            onClick={() => setShowErrorDialog(true)}
          >
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          </Button>
        )}
        <select
          value={selectedModelValue}
          disabled={running || models.length === 0}
          aria-label={modelError ?? 'Provider and model'}
          className="h-7 w-44 max-w-[42%] min-w-0 shrink rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
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
                  : models.length === 0
                    ? '未配置供应商模型（请先在设置中添加供应商档案）'
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
        {(() => {
          const selected = models.find((candidate) => modelValue(candidate.provider, candidate.modelId) === selectedModelValue);
          // The budget is resolved and persisted by main, so the ring knows its
          // denominator without the model catalog; the catalog only covers the
          // window before a Session has one of its own (a fresh branch, or a
          // snapshot taken before budgets were stored). The fallback runs the
          // same trigger rule as the main process, so its tick cannot drift.
          const budget = session.contextBudget ??
            (selected ? agentContextBudgetForModel(selected) : null);
          if (!budget) return null;
          // A reading always carries the window it was measured against, so it
          // is only paired with the Session's own budget.
          const usage = session.contextBudget ? session.contextUsage ?? null : null;
          const detail = usage ? contextUsageTitle(usage, budget) : contextBudgetTitle(budget);
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="iris-agent-context-usage"
                  data-tone={usage ? contextUsageTone(usage, budget) : 'normal'}
                  role="img"
                  aria-label={detail}
                >
                  <AgentContextRing usage={usage} budget={budget} />
                  <span className="iris-agent-context-value tabular-nums">
                    {usage ? contextUsageLabel(usage, budget) : formatTokenCount(budget.windowTokens)}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent>{detail}</TooltipContent>
            </Tooltip>
          );
        })()}
        {!running && session.canRewindLatestIntent && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => void rewindIrisAgent(session.id)}
            aria-label="回退最后一项意图及可安全还原的文件改动"
          >
            <Undo2 className="!size-3.5" />
          </Button>
        )}
      </div>

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

      <div
        ref={messagesRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
        style={{ overflowAnchor: 'none' }}
      >
        <div ref={messagesContentRef} className="min-h-full">
          {session.intents.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <Bot className="h-9 w-9 text-muted-foreground/40" />
              <p>已固定当前 anchor。发送消息前会重新读取最新内容。</p>
            </div>
          ) : (
            <div className="space-y-4">
              {session.intents.map((intent) => {
                return (
                  <div key={intent.id} className="space-y-2">
                  <UserMessage
                    message={intent.user}
                    onOpenPrompt={intent.user.contextAvailable ? () => openContext(intent.id) : undefined}
                    artifactTitle={intent.user.contextTitle}
                    {...(intent.canForkFromInput ? { onFork: () => {
                      branchIrisAgent(session.id, intent.id, true).then((forked) => {
                        if (forked) onForked?.(forked);
                      }).catch(() => undefined);
                    } } : {})}
                  />
                  {groupAgentCards(intent.cards).map((group) => group.kind === 'file-group' ? (
                    <FileChangeGroupCard key={group.cards[0]!.id} cards={group.cards} />
                  ) : (
                    <AgentActivityCard
                      key={group.card.id}
                      sessionId={session.id}
                      card={group.card}
                      canRetry={false}
                      onRetry={() => undefined}
                      {...(group.card.kind === 'agent-reply' && intent.canFork ? { onFork: () => {
                        branchIrisAgent(session.id, intent.id).then((forked) => {
                          if (forked) onForked?.(forked);
                        }).catch(() => undefined);
                      } } : {})}
                      onOpenTerminal={(terminalId) => setOpenTerminalId(terminalId)}
                    />
                  ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <form
        className="shrink-0 border-t p-2"
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
      >
        <div className="flex gap-2">
          <TextEditContextMenu targetRef={draftRef} disabled={running}>
            <textarea
              ref={draftRef}
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
          </TextEditContextMenu>
          <Button
            type="submit"
            size="icon"
            disabled={running ? false : !selectedModelAvailable || (
              draft.trim() === '' && !(session.anchor.kind === 'document' && session.intents.length === 0)
            )}
            aria-label={running ? '停止' : draft.trim() === '' ? '开始' : '发送'}
          >
            {running ? <Square className="!size-4" /> : draft.trim() === '' && session.anchor.kind === 'document' && session.intents.length === 0
              ? <Play className="!size-4" />
              : <Send className="!size-4" />}
          </Button>
        </div>
      </form>

      {openTerminal && (
        <AgentTerminalDialog
          sessionId={session.id}
          terminal={openTerminal}
          onClose={() => setOpenTerminalId(null)}
        />
      )}
    </div>
  );
}

/**
 * Header entry point for Agent command terminals. The tab strip is gone, so
 * this is the only way to open a terminal workspace. A running command shows a
 * live dot but never steals focus or scroll position.
 */
function TerminalLauncher({
  terminals,
  onOpen,
}: {
  terminals: IrisAgentTerminalView[];
  onOpen: (terminalId: string) => void;
}): JSX.Element {
  const ordered = [...terminals].reverse();
  const running = terminals.some((terminal) => terminal.state === 'running');
  const trigger = (
    <Button
      variant="ghost"
      size="icon"
      className="relative h-7 w-7 shrink-0"
      aria-label={running ? '查看终端输出（有命令正在运行）' : '查看终端输出'}
      {...(ordered.length === 1 ? { onClick: () => onOpen(ordered[0]!.id) } : {})}
    >
      <SquareTerminal className="!size-3.5" />
      {running && (
        <span className="pointer-events-none absolute right-0.5 top-0.5" aria-hidden="true">
          <span
            className="iris-agent-terminal-dot block h-1.5 w-1.5 rounded-full bg-emerald-500"
            data-running="true"
          />
        </span>
      )}
    </Button>
  );
  if (ordered.length === 1) return trigger;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>终端输出</DropdownMenuLabel>
        {ordered.map((terminal) => (
          <DropdownMenuItem key={terminal.id} onClick={() => onOpen(terminal.id)}>
            <SquareTerminal className="!size-3.5 shrink-0 text-muted-foreground" />
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px]"
              aria-label={terminal.command}
            >
              {terminal.command.trim() || 'Terminal'}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {terminalMenuState(terminal)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function terminalMenuState(terminal: IrisAgentTerminalView): string {
  if (terminal.state === 'running') return '运行中';
  if (terminal.outcome === 'timeout') return '已超时';
  if (terminal.outcome === 'canceled') return '已取消';
  if (terminal.exitCode === undefined || terminal.exitCode === null) return '已结束';
  return `退出码 ${terminal.exitCode}`;
}

function AgentActivityCard({
  sessionId,
  card,
  canRetry,
  onRetry,
  onOpenTerminal,
  onFork,
}: {
  sessionId: string;
  card: IrisAgentCardView;
  canRetry: boolean;
  onRetry: () => void;
  onOpenTerminal: (terminalId: string) => void;
  onFork?: () => void;
}): JSX.Element {
  switch (card.kind) {
    case 'local-retrieval':
      return <LocalRetrievalCard card={card} onOpenTerminal={onOpenTerminal} />;
    case 'file-change':
      return <FileChangeGroupCard cards={[card]} />;
    case 'terminal-operation':
      return <TerminalOperationCard card={card} onOpenTerminal={onOpenTerminal} />;
    case 'task':
      return <BackgroundTaskCard sessionId={sessionId} card={card} />;
    case 'agent-reply':
      return <AgentReplyCard
        card={card}
        canRetry={canRetry}
        onRetry={onRetry}
        {...(onFork ? { onFork } : {})}
      />;
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
      cardType="retrievals"
      icon={<FolderSearch className="h-4 w-4" />}
      title="信息检索"
      summary={failed > 0 ? `${summary} · ${failed} 项失败` : summary}
      state={card.state}
      action={card.items.length > 5 ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={expanded ? '收起获取记录' : '展开全部获取记录'}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="!size-3.5" /> : <ChevronRight className="!size-3.5" />}
        </Button>
      ) : undefined}
    >
      <div>
        {!expanded && card.items.length > 5 && (
          <div className="bg-muted/10 px-4 py-1.5 text-center text-[11px] text-muted-foreground">
            另有 {card.items.length - 5} 项
          </div>
        )}
        {visibleItems.map((item) => (
          <div key={item.id} className="flex min-h-7 min-w-0 items-center gap-2.5 px-4 py-1 text-xs">
            {item.kind === 'file'
              ? <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--iris-card-retrievals)]" />
              : <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-[var(--iris-card-retrievals)]" />}
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" aria-label={item.label}>
              {item.label}
            </span>
            <CompactRowStateIcon
              state={item.state}
              accent="var(--iris-card-retrievals)"
              detail={[item.error, item.errorDetail].filter(Boolean).join('\n\n') || undefined}
              onClick={item.state === 'failed' && item.terminalId
                ? () => onOpenTerminal(item.terminalId!)
                : undefined}
            />
          </div>
        ))}
      </div>
    </CardFrame>
  );
}

type FileChangeCardView = Extract<IrisAgentCardView, { kind: 'file-change' }>;

function FileChangeGroupCard({
  cards,
}: {
  cards: FileChangeCardView[];
}): JSX.Element {
  const additions = cards.reduce((total, card) => total + diffLineStats(card.diff).additions, 0);
  const deletions = cards.reduce((total, card) => total + diffLineStats(card.diff).deletions, 0);
  const summary = `${cards.length} 个文件${additions || deletions ? ` · +${additions} -${deletions}` : ''}`;
  return (
    <CardFrame
      cardType="files"
      icon={<FileDiff className="h-4 w-4" />}
      title="文件变更"
      summary={summary}
      state={groupState(cards)}
    >
      <div>
        {cards.map((card) => {
          const stats = diffLineStats(card.diff);
          const action = card.action === 'created' ? '创建' : card.action === 'updated' ? '修改' : card.action === 'unchanged' ? '未改变' : '写入失败';
          return (
            <div key={card.id} className="flex min-h-7 items-center gap-2.5 px-4 py-1 text-xs">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]" aria-label={card.path}>{card.path}</span>
              {(stats.additions || stats.deletions) ? (
                <span className="shrink-0 font-mono text-[11px] font-semibold">
                  <span className="text-emerald-600 dark:text-emerald-400">+{stats.additions}</span>
                  {' '}
                  <span className="text-red-600 dark:text-red-400">-{stats.deletions}</span>
                </span>
              ) : (
                <span className="shrink-0 text-[11px] text-muted-foreground">{action}</span>
              )}
              <CompactRowStateIcon
                state={card.state}
                accent="var(--iris-card-files)"
                detail={card.error}
              />
            </div>
          );
        })}
      </div>
    </CardFrame>
  );
}

function groupAgentCards(cards: IrisAgentCardView[]): Array<
  | { kind: 'file-group'; cards: FileChangeCardView[] }
  | { kind: 'single'; card: Exclude<IrisAgentCardView, FileChangeCardView> }
> {
  const groups: Array<{ kind: 'file-group'; cards: FileChangeCardView[] } | { kind: 'single'; card: Exclude<IrisAgentCardView, FileChangeCardView> }> = [];
  for (const card of cards) {
    if (card.kind === 'file-change') {
      const previous = groups.at(-1);
      if (previous?.kind === 'file-group') previous.cards.push(card);
      else groups.push({ kind: 'file-group', cards: [card] });
    } else {
      groups.push({ kind: 'single', card });
    }
  }
  return groups;
}

function diffLineStats(diff: string | undefined): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function groupState(cards: FileChangeCardView[]): IrisAgentCardState {
  if (cards.some((card) => card.state === 'failed')) return 'failed';
  if (cards.some((card) => card.state === 'partial')) return 'partial';
  if (cards.some((card) => card.state === 'running')) return 'running';
  if (cards.some((card) => card.state === 'stopped')) return 'stopped';
  if (cards.every((card) => card.state === 'unchanged')) return 'unchanged';
  return 'completed';
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
      cardType="operations"
      icon={<SquareTerminal className="h-4 w-4" />}
      title="执行命令"
      summary={cardStateLabel(card.state)}
      state={card.state}
      action={multiline ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={expanded ? '收起命令' : '展开完整命令'}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="!size-3.5" /> : <ChevronRight className="!size-3.5" />}
        </Button>
      ) : undefined}
    >
      <div className="flex items-start gap-2.5 px-4 py-3.5">
        <TerminalStateDot state={card.state} />
        <pre
          className={`${expanded ? 'max-h-none' : 'max-h-40'} min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5`}
          aria-label="执行命令"
        >
          {card.command}
        </pre>
      </div>
      {card.error && (
        <details className="border-t border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
          <summary className="cursor-pointer select-none font-medium">展开失败原因</summary>
          <div className="mt-1.5 whitespace-pre-wrap break-words">{card.error}</div>
          {card.errorDetail && (
            <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-destructive/20 bg-background p-2 font-mono text-[10px] text-foreground">
              {card.errorDetail}
            </pre>
          )}
        </details>
      )}
      {card.terminalId && (
        <div className="flex justify-end border-t border-border/40 bg-muted/10 px-3 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => onOpenTerminal(card.terminalId!)}
          >
            <SquareTerminal className="mr-1 !size-3" />
            查看终端输出
          </Button>
        </div>
      )}
    </CardFrame>
  );
}

function BackgroundTaskCard({
  sessionId,
  card,
}: {
  sessionId: string;
  card: Extract<IrisAgentCardView, { kind: 'task' }>;
}): JSX.Element {
  const [log, setLog] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  const status = card.status === 'succeeded'
    ? '已完成'
    : card.status === 'failed' || card.status === 'lost'
      ? '失败'
      : card.status === 'canceled'
        ? '已取消'
        : card.status === 'starting'
          ? '启动中'
          : '运行中';
  return (
    <CardFrame
      cardType="tasks"
      icon={<Play className="h-4 w-4" />}
      title={card.title}
      summary={`${status} · ${card.taskId}`}
      state={card.state}
      action={card.state === 'running' ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 text-[11px]"
          onClick={() => void cancelIrisAgentTask(sessionId, card.taskId).catch(() => undefined)}
        >
          <Square className="mr-1 !size-3" />
          取消
        </Button>
      ) : undefined}
    >
      <div className="space-y-2 px-4 py-3.5 text-xs">
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
          {card.command}
        </pre>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>{card.outputBytes.toLocaleString()} bytes</span>
          {card.logRef && <span className="truncate font-mono" aria-label={card.logRef}>日志已持久化</span>}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 text-[11px]"
          disabled={loadingLog}
          onClick={() => {
            setLoadingLog(true);
            setLogError(null);
            void getIrisAgentTask(card.taskId).then((result) => {
              if (result.kind !== 'task') return;
              try {
                const parsed: unknown = JSON.parse(result.outputText);
                const output = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>).output : undefined;
                setLog(typeof output === 'string' ? output : result.outputText);
              } catch {
                setLog(result.outputText);
              }
            }).catch((error: unknown) => {
              setLogError(error instanceof Error ? error.message : String(error));
            }).finally(() => setLoadingLog(false));
          }}
        >
          <FileText className="mr-1 !size-3" />
          查看日志
        </Button>
        {log !== null && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border bg-background p-2 font-mono text-[11px]">{log || '暂无输出'}</pre>}
        {logError && <div className="text-destructive">{logError}</div>}
        {card.error && <div className="whitespace-pre-wrap break-words text-destructive">{card.error}</div>}
      </div>
    </CardFrame>
  );
}

function AgentReplyCard({
  card,
  canRetry,
  onRetry,
  onFork,
}: {
  card: Extract<IrisAgentCardView, { kind: 'agent-reply' }>;
  canRetry: boolean;
  onRetry: () => void;
  onFork?: () => void;
}): JSX.Element {
  const placeholder = card.state === 'stopped' ? '本项意图已暂停。' : '正在回复…';
  return (
    <CardFrame
      cardType="message"
      icon={<BotMessageSquare className="h-4 w-4" />}
      title="AI 回复"
      summary={card.state === 'running'
        ? '正在回复'
        : card.state === 'stopped'
          ? card.excludedFromContext ? '已暂停 · 未进入上下文' : '已暂停'
          : card.excludedFromContext
            ? '未进入上下文'
            : '已回复'}
      state={card.state}
      action={onFork ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground"
          aria-label="从此回复创建对话分支"
          onClick={onFork}
        >
          <GitBranch className="!size-3.5" />
        </Button>
      ) : undefined}
    >
      <div className="markdown-body min-w-0 px-4 py-3 text-[13px] leading-relaxed">
        {card.content
          ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.content}</ReactMarkdown>
          : <span className="text-muted-foreground">{placeholder}</span>}
      </div>
      {card.error && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-3">
          <div className="flex items-start gap-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-pre-wrap break-words">{card.error}</span>
          </div>
          {canRetry && (
            <div className="mt-2.5 flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 border-destructive/40 bg-background text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={onRetry}
              >
                <RotateCcw className="mr-1.5 !size-3.5" />
                重试
              </Button>
            </div>
          )}
        </div>
      )}
    </CardFrame>
  );
}

type CardType = 'files' | 'operations' | 'retrievals' | 'tasks' | 'message';

function CardFrame({
  cardType,
  icon,
  title,
  summary,
  state,
  action,
  children,
}: {
  cardType: CardType;
  icon: ReactNode;
  title: string;
  summary?: string;
  state: IrisAgentCardState;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const accent = `var(--iris-card-${cardType})`;

  return (
    <section
      className="iris-agent-card overflow-hidden rounded-lg border border-border/80 bg-card/40"
      data-state={state}
      style={{ '--iris-agent-card-accent': accent } as CSSProperties}
      aria-label={title}
    >
      <div className="flex min-h-10 items-center gap-2.5 px-4 py-2">
        <span className="iris-agent-card-icon shrink-0" aria-hidden="true">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="shrink-0 text-[13px] font-semibold text-foreground">{title}</h3>
            {summary && (
              <span className="min-w-0 truncate text-[11px] text-muted-foreground" aria-label={summary}>
                {summary}
              </span>
            )}
          </div>
        </div>
        {action}
        <span className="flex w-5 shrink-0 items-center justify-center">
          <CardStateIcon state={state} />
        </span>
      </div>
      <div className="iris-agent-card-line" aria-hidden="true" />
      {children}
    </section>
  );
}

function CardStateIcon({ state }: { state: IrisAgentCardState }): JSX.Element {
  if (state === 'running') {
    return (
      <span className="iris-agent-working-dots" role="img" aria-label="运行中">
        <span />
        <span />
        <span />
      </span>
    );
  }
  if (state === 'failed') {
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="失败" />;
  }
  if (state === 'partial') {
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="部分失败" />;
  }
  if (state === 'stopped') {
    return <Square className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="已停止" />;
  }
  return <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-label={state === 'unchanged' ? '无变化' : '完成'} />;
}

function TerminalStateDot({ state }: { state: IrisAgentCardState }): JSX.Element {
  const label = cardStateLabel(state);
  const color = state === 'failed'
    ? 'bg-destructive'
    : state === 'partial'
      ? 'bg-amber-500'
      : state === 'completed' || state === 'unchanged'
        ? 'bg-emerald-500'
        : state === 'running'
          ? 'bg-[var(--iris-agent-card-accent)]'
          : 'bg-muted-foreground';
  return (
    <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <span
        className={`iris-agent-terminal-dot h-2 w-2 rounded-full ${color}`}
        data-running={state === 'running' || undefined}
        role="img"
        aria-label={label}
      />
    </span>
  );
}

function CompactRowStateIcon({
  state,
  accent,
  detail,
  onClick,
}: {
  state: IrisAgentCardState | 'canceled';
  accent: string;
  detail?: string | undefined;
  onClick?: (() => void) | undefined;
}): JSX.Element {
  const label = detail ? `${retrievalStateLabel(state)}：${detail}` : retrievalStateLabel(state);
  const icon = state === 'running'
    ? <LoaderCircle className="h-3 w-3 animate-spin" style={{ color: accent }} />
    : state === 'failed' || state === 'partial'
      ? <X className={`h-3.5 w-3.5 ${state === 'partial' ? 'text-amber-500' : 'text-destructive'}`} />
      : state === 'canceled' || state === 'stopped'
        ? <X className="h-3.5 w-3.5 text-muted-foreground" />
        : <Check className="h-3.5 w-3.5 text-emerald-500" />;
  const className = `flex h-5 w-5 shrink-0 items-center justify-center rounded-sm${onClick ? ' hover:bg-muted' : ''}`;
  if (onClick) {
    return (
      <button type="button" className={className} aria-label={`${label}，打开终端`} onClick={onClick}>
        {icon}
      </button>
    );
  }
  return <span className={className} role="img" aria-label={label}>{icon}</span>;
}

function retrievalStateLabel(state: IrisAgentCardState | 'canceled'): string {
  if (state === 'running') return '运行中';
  if (state === 'failed') return '失败';
  if (state === 'partial') return '部分失败';
  if (state === 'canceled' || state === 'stopped') return '已停止';
  if (state === 'unchanged') return '无变化';
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
  onFork,
}: {
  message: IrisAgentUserView;
  onOpenPrompt: (() => void) | undefined;
  artifactTitle: string | undefined;
  onFork?: (() => void) | undefined;
}): JSX.Element {
  return (
    <section
      className="iris-agent-card overflow-hidden rounded-lg border border-border/80 bg-card/40"
      style={{ '--iris-agent-card-accent': 'var(--primary)' } as CSSProperties}
      aria-label="你的指令"
    >
      <div className="flex min-h-10 items-center gap-2.5 px-4 py-2">
        <span className="iris-agent-card-icon shrink-0" aria-hidden="true">
          <UserRound />
        </span>
        <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-foreground">你的指令</h3>
        <div className="flex items-center gap-1">
          {onOpenPrompt && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              aria-label={artifactTitle}
              onClick={onOpenPrompt}
            >
              <FileText className="!size-3.5" />
            </Button>
          )}
          {onFork && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              aria-label="从此输入重新开始"
              onClick={onFork}
            >
              <GitBranch className="!size-3.5" />
            </Button>
          )}
        </div>
        <span className="w-5 shrink-0" aria-hidden="true" />
      </div>
      <div className="iris-agent-card-line" aria-hidden="true" />
      <div className="whitespace-pre-wrap break-words px-4 py-3 text-sm leading-relaxed">
        {message.content}
      </div>
    </section>
  );
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
