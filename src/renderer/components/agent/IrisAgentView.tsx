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
  ImagePlus,
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
  IrisAgentAttachment,
  IrisAgentCardState,
  IrisAgentCardView,
  IrisAgentModelOption,
  IrisAgentLivePhase,
  IrisAgentSessionInfo,
  IrisAgentUserView,
  IrisAgentTaskView,
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
  readIrisAgentAttachment,
  sendIrisAgentMessage,
  setIrisAgentModel,
  stopIrisAgent,
  cancelIrisAgentTask,
  continueIrisAgentTerminalSupervision,
} from '@renderer/lib/iris-agent-actions';
import { AgentTerminalDialog } from '@renderer/components/agent/AgentTerminalDialog';
import { AgentTaskDialog } from '@renderer/components/agent/AgentTaskDialog';
import {
  assertAttachmentCapacity,
  assertAttachmentTotalBytes,
  imageFilesFrom,
  readAgentImageFile,
  toAttachmentUploads,
  type PendingAgentImage,
} from '@renderer/lib/agent-image-attachments';
import {
  isActiveTaskStatus,
  statusDotClass,
  taskStatusLabel,
  taskStatusTone,
  terminalStatusLabel,
} from '@renderer/lib/agent-status';
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
import { useIrisAgentSessions } from '@renderer/stores/iris-agent-store';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const attachmentLoads = new Map<string, Promise<string | null>>();

/** Shares only in-flight reads; resolved base64 strings are not retained globally. */
function loadAttachmentOnce(sessionId: string, attachmentId: string): Promise<string | null> {
  const key = `${sessionId}:${attachmentId}`;
  const existing = attachmentLoads.get(key);
  if (existing) return existing;
  const pending = readIrisAgentAttachment(sessionId, attachmentId);
  attachmentLoads.set(key, pending);
  pending.then(
    () => { if (attachmentLoads.get(key) === pending) attachmentLoads.delete(key); },
    () => { if (attachmentLoads.get(key) === pending) attachmentLoads.delete(key); },
  ).catch(() => undefined);
  return pending;
}

function useLazyAttachment(
  sessionId: string,
  attachmentId: string,
): {
    containerRef: React.RefObject<HTMLDivElement>;
    dataUrl: string | null;
    failed: boolean;
  } {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const target = containerRef.current;
    if (!target || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: '160px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [sessionId, attachmentId]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setDataUrl(null);
    setFailed(false);
    loadAttachmentOnce(sessionId, attachmentId)
      .then((url) => {
        if (!active) return;
        if (url) setDataUrl(url);
        else setFailed(true);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => { active = false; };
  }, [visible, sessionId, attachmentId]);

  return { containerRef, dataUrl, failed };
}

export function IrisAgentView({
  session,
  onForked,
}: {
  session: IrisAgentSessionInfo;
  onForked?: (session: IrisAgentSessionInfo) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingAgentImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [models, setModels] = useState<IrisAgentModelOption[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [openTerminalId, setOpenTerminalId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const filePickerRef = useRef<HTMLInputElement | null>(null);
  // Object URLs are owned by this component; the ref mirrors the state so the
  // unmount cleanup can revoke whatever is still live without re-subscribing.
  const pendingImagesRef = useRef<PendingAgentImage[]>([]);
  const imageAddQueueRef = useRef<Promise<void>>(Promise.resolve());
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const modelRequest = useRef(0);
  const autoSelectingModel = useRef<string | null>(null);
  const running = isSessionRunning(session);
  const livePhase = useIrisAgentSessions().phases[session.id];
  const activePhase: IrisAgentLivePhase | null = session.state === 'running'
    ? livePhase?.phase ?? 'requesting'
    : null;
  const thinkingElapsed = useThinkingElapsed(
    livePhase?.startedAt ?? null,
    activePhase === 'thinking',
  );
  const statusText = statusLabel(session.state, activePhase, thinkingElapsed);
  // Only terminals that crossed the display threshold get a workspace entry;
  // short commands stay reachable from their card's output button.
  const terminalWorkspaces = session.terminals.filter((terminal) => terminal.revealed);
  const openTerminal = session.terminals.find((terminal) => terminal.id === openTerminalId) ?? null;
  // Tasks stay in the session projection, so an open dialog follows the live
  // status instead of holding a copy taken when it was opened.
  const tasks = session.tasks ?? [];
  const openTask = tasks.find((task) => task.taskId === openTaskId) ?? null;

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
  // An unknown or text-only model must not accept an attachment: silently
  // dropping the picture would be worse than refusing it.
  const selectedModel = session.model
    ? models.find(
        (model) =>
          model.provider === session.model?.provider && model.modelId === session.model.modelId,
      ) ?? null
    : null;
  const modelAcceptsImages = selectedModel?.capabilities?.input.includes('image') ?? false;
  const canAttachImages = modelAcceptsImages && !running && !sending;
  const attachLabel = modelAcceptsImages
    ? '添加图片（也可直接粘贴或拖入）'
    : selectedModelAvailable
      ? '当前模型不支持图片输入'
      : '先选择可用模型';

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

  const removePendingImage = (id: string): void => {
    const current = pendingImagesRef.current;
    const target = current.find((image) => image.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    const next = current.filter((image) => image.id !== id);
    pendingImagesRef.current = next;
    setPendingImages(next);
  };

  const addImageFiles = useCallback((files: readonly File[]): Promise<void> => {
    const task = imageAddQueueRef.current.then(async () => {
      if (files.length === 0) return;
      // Serialized additions make count and byte limits exact even when paste
      // and drop events arrive before React has committed the prior state.
      const current = pendingImagesRef.current;
      try {
        assertAttachmentCapacity(current.length, files.length);
      } catch (error) {
        setImageError(error instanceof Error ? error.message : String(error));
        return;
      }
      const added: PendingAgentImage[] = [];
      let totalBytes = current.reduce((sum, image) => sum + image.bytes, 0);
      let failure: string | null = null;
      for (const file of files) {
        try {
          const image = await readAgentImageFile(file);
          try {
            assertAttachmentTotalBytes(totalBytes, image.bytes);
          } catch (error) {
            URL.revokeObjectURL(image.previewUrl);
            throw error;
          }
          totalBytes += image.bytes;
          added.push(image);
        } catch (error) {
          failure ??= error instanceof Error ? error.message : String(error);
        }
      }
      if (added.length > 0) {
        const next = [...current, ...added];
        pendingImagesRef.current = next;
        setPendingImages(next);
      }
      setImageError(failure);
    });
    // async-boundary: handled — every queued task catches file errors inline.
    imageAddQueueRef.current = task.catch(() => undefined);
    return task;
  }, []);

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  // Leaving the view must not leak the thumbnails it created.
  useEffect(() => () => {
    for (const image of pendingImagesRef.current) URL.revokeObjectURL(image.previewUrl);
    pendingImagesRef.current = [];
  }, []);

  useEffect(() => {
    // Keyed on the model's capability alone: a run in flight also blocks
    // attaching, but that is temporary and must not discard the user's images.
    if (sending || modelAcceptsImages || pendingImagesRef.current.length === 0) return;
    // A model switch can remove image input; the attachments cannot be sent
    // any more, so they are dropped with an explanation instead of silently
    // travelling to a model that would ignore them.
    for (const image of pendingImagesRef.current) URL.revokeObjectURL(image.previewUrl);
    pendingImagesRef.current = [];
    setPendingImages([]);
    setImageError('当前模型不支持图片输入，已移除待发送的图片。');
  }, [modelAcceptsImages, sending]);

  const submitDraft = (): void => {
    if (running) {
      void stopIrisAgent(session.id);
      return;
    }
    if (sending) return;
    const canStartFromDocument = session.anchor.kind === 'document' && session.intents.length === 0;
    if (draft.trim() === '' && !canStartFromDocument) return;
    if (!selectedModelAvailable) return;
    const text = draft;
    const attachments = toAttachmentUploads(pendingImages);
    const submittedImages = [...pendingImages];
    setSending(true);
    void sendIrisAgentMessage(session.id, text, attachments)
      .then((sent) => {
        if (!sent) return;
        setDraft((current) => current === text ? '' : current);
        const submittedIds = new Set(submittedImages.map((image) => image.id));
        for (const image of submittedImages) URL.revokeObjectURL(image.previewUrl);
        const remaining = pendingImagesRef.current.filter((image) => !submittedIds.has(image.id));
        pendingImagesRef.current = remaining;
        setPendingImages(remaining);
        setImageError(null);
      })
      .finally(() => setSending(false));
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
          data-phase={activePhase ?? undefined}
        >
          <Bot className="h-4 w-4" />
          {(activePhase === 'thinking' || activePhase === 'generating') && (
            <span className="iris-agent-avatar-orbit" aria-hidden="true"><span /></span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">Iris Agent</div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="truncate">{statusText}</span>
            {activePhase === 'generating' && (
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
        {tasks.length > 0 && <TaskLauncher tasks={tasks} onOpen={setOpenTaskId} />}
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
                    sessionId={session.id}
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
                      onOpenTask={(taskId) => setOpenTaskId(taskId)}
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
        className={`shrink-0 border-t p-2${dragging ? ' bg-primary/5' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
        onDragOver={(event) => {
          // Only claim the drop when an image is actually being dragged, so a
          // text or file drag keeps its normal browser behaviour.
          if (!canAttachImages || ![...event.dataTransfer.items].some((item) => item.kind === 'file')) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(event) => {
          setDragging(false);
          if (!canAttachImages) return;
          const files = imageFilesFrom(event.dataTransfer);
          if (files.length === 0) return;
          event.preventDefault();
          void addImageFiles(files);
        }}
      >
        {pendingImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingImages.map((image) => (
              <div
                key={image.id}
                className="group relative overflow-hidden rounded-md border border-border bg-muted/30"
              >
                <img
                  src={image.previewUrl}
                  alt={image.name}
                  className="h-16 w-auto max-w-[8rem] object-contain"
                />
                <button
                  type="button"
                  className="absolute right-0.5 top-0.5 rounded-sm bg-background/85 p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                  aria-label={`移除图片 ${image.name}`}
                  onClick={() => removePendingImage(image.id)}
                >
                  <X className="!size-3" />
                </button>
                <div className="max-w-[8rem] truncate px-1 py-0.5 text-[10px] text-muted-foreground">
                  {formatAttachmentSize(image.bytes)}
                </div>
              </div>
            ))}
          </div>
        )}
        {imageError && (
          <div className="mb-2 flex items-start gap-1.5 text-[11px] text-destructive">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 break-words">{imageError}</span>
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={filePickerRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              // Reset first so choosing the same file twice still fires.
              event.target.value = '';
              void addImageFiles(files);
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-10 w-9 shrink-0 text-muted-foreground"
                disabled={!canAttachImages}
                aria-label={attachLabel}
                onClick={() => filePickerRef.current?.click()}
              >
                <ImagePlus className="!size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{attachLabel}</TooltipContent>
          </Tooltip>
          <TextEditContextMenu targetRef={draftRef} disabled={running || sending}>
            <textarea
              ref={draftRef}
              value={draft}
              disabled={running || sending}
              rows={2}
              className="min-h-10 flex-1 resize-none rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
              placeholder={running
                ? 'Iris Agent 正在工作…'
                : !selectedModelAvailable
                  ? '先选择可用模型'
                  : pendingImages.length > 0 && draft.trim() === ''
                    ? `已附加 ${String(pendingImages.length)} 张图片，请输入要做什么`
                    : modelAcceptsImages
                      ? '输入给 Iris Agent 的任务（可粘贴或拖入图片）'
                      : '输入给 Iris Agent 的任务'}
              onChange={(event) => setDraft(event.target.value)}
              onPaste={(event) => {
                if (!canAttachImages) return;
                const files = imageFilesFrom(event.clipboardData);
                if (files.length === 0) return;
                // Do not prevent the default: a clipboard payload may contain
                // both text and image data, and the textarea must keep the text.
                void addImageFiles(files);
              }}
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
            disabled={sending || (running ? false : !selectedModelAvailable || (
              draft.trim() === '' && !(session.anchor.kind === 'document' && session.intents.length === 0)
            ))}
            aria-label={sending ? '发送中' : running ? '停止' : draft.trim() === '' ? '开始' : '发送'}
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

      {openTask && (
        <AgentTaskDialog
          key={openTask.taskId}
          sessionId={session.id}
          task={openTask}
          onClose={() => setOpenTaskId(null)}
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
              {terminalStatusLabel(terminal)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Menu keeps the newest few tasks behind the icon; the rest stay reachable. */
const TASK_MENU_RECENT_LIMIT = 8;

/**
 * Header entry point for background tasks, next to the terminal one. It exists
 * only when this Session has tasks, carries a count while any are still live,
 * and opens the dialog in place — no navigation, no focus steal.
 */
function TaskLauncher({
  tasks,
  onOpen,
}: {
  tasks: IrisAgentTaskView[];
  onOpen: (taskId: string) => void;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const newestFirst = (left: IrisAgentTaskView, right: IrisAgentTaskView): number =>
    right.createdAt - left.createdAt;
  const activeTasks = tasks.filter((task) => isActiveTaskStatus(task.status)).sort(newestFirst);
  const settledTasks = tasks.filter((task) => !isActiveTaskStatus(task.status)).sort(newestFirst);
  const ordered = [...activeTasks, ...settledTasks];
  const visible = showAll ? ordered : ordered.slice(0, TASK_MENU_RECENT_LIMIT);
  const trigger = (
    <Button
      variant="ghost"
      size="icon"
      className="relative h-7 w-7 shrink-0"
      aria-label={activeTasks.length > 0
        ? `查看后台任务（${activeTasks.length} 个仍在运行）`
        : '查看后台任务'}
      {...(ordered.length === 1 ? { onClick: () => onOpen(ordered[0]!.taskId) } : {})}
    >
      <Play className="!size-3.5" />
      {activeTasks.length > 0 && (
        <span
          className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-emerald-500 px-0.5 text-[9px] font-semibold leading-none text-white"
          aria-hidden="true"
        >
          {activeTasks.length}
        </span>
      )}
    </Button>
  );
  if (ordered.length === 1) return trigger;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[60vh] w-80 overflow-y-auto">
        <DropdownMenuLabel>后台任务</DropdownMenuLabel>
        {visible.map((task) => (
          <DropdownMenuItem key={task.taskId} onClick={() => onOpen(task.taskId)}>
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(taskStatusTone(task.status))}`}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-[11px]" aria-label={task.command}>
              {task.title}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {taskStatusLabel(task.status)}
            </span>
          </DropdownMenuItem>
        ))}
        {!showAll && ordered.length > TASK_MENU_RECENT_LIMIT && (
          <DropdownMenuItem onClick={() => setShowAll(true)}>
            <ChevronRight className="!size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 text-[11px]">查看全部 {ordered.length} 个任务</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentActivityCard({
  sessionId,
  card,
  canRetry,
  onRetry,
  onOpenTerminal,
  onOpenTask,
  onFork,
}: {
  sessionId: string;
  card: IrisAgentCardView;
  canRetry: boolean;
  onRetry: () => void;
  onOpenTerminal: (terminalId: string) => void;
  onOpenTask: (taskId: string) => void;
  onFork?: () => void;
}): JSX.Element {
  switch (card.kind) {
    case 'local-retrieval':
      return <LocalRetrievalCard card={card} sessionId={sessionId} onOpenTerminal={onOpenTerminal} />;
    case 'file-change':
      return <FileChangeGroupCard cards={[card]} />;
    case 'terminal-operation':
      return <TerminalOperationCard card={card} onOpenTerminal={onOpenTerminal} />;
    case 'task':
      return <BackgroundTaskCard sessionId={sessionId} card={card} onOpenTask={onOpenTask} />;
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
  sessionId,
  onOpenTerminal,
}: {
  card: Extract<IrisAgentCardView, { kind: 'local-retrieval' }>;
  sessionId: string;
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
          <div key={item.id} className="min-w-0">
            <div className="flex min-h-7 min-w-0 items-center gap-2.5 px-4 py-1 text-xs">
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
            {item.image && <RetrievalImage sessionId={sessionId} attachment={item.image} />}
          </div>
        ))}
      </div>
    </CardFrame>
  );
}

/**
 * One image the Agent read, loaded on demand from main. The card shows a
 * bounded thumbnail rather than the model's full-resolution payload so a long
 * conversation cannot be pushed out of shape by its own attachments.
 */
function RetrievalImage({
  sessionId,
  attachment,
}: {
  sessionId: string;
  attachment: IrisAgentAttachment;
}): JSX.Element {
  const { containerRef, dataUrl, failed } = useLazyAttachment(sessionId, attachment.id);

  if (failed) {
    return (
      <div ref={containerRef} className="px-4 pb-2 pl-10 text-[11px] text-muted-foreground">
        图片已不可读取（{attachment.name}）
      </div>
    );
  }
  return (
    <div ref={containerRef} className="px-4 pb-2 pl-10">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={attachment.name}
          loading="lazy"
          className="max-h-40 rounded-md border border-border/70 bg-muted/30 object-contain"
        />
      ) : (
        <div className="h-16 w-24 animate-pulse rounded-md border border-border/60 bg-muted/30" aria-hidden="true" />
      )}
    </div>
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
  onOpenTask,
}: {
  sessionId: string;
  card: Extract<IrisAgentCardView, { kind: 'task' }>;
  onOpenTask: (taskId: string) => void;
}): JSX.Element {
  const active = isActiveTaskStatus(card.status);
  const [canceling, setCanceling] = useState(false);
  // The request is not the state change: keep the pending label until the
  // session reports a settled status (or the request itself fails).
  useEffect(() => {
    if (!active) setCanceling(false);
  }, [active]);
  return (
    <CardFrame
      cardType="tasks"
      icon={<Play className="h-4 w-4" />}
      title={card.title}
      summary={taskStatusLabel(card.status)}
      state={card.state}
      action={active ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 text-[11px]"
          disabled={canceling}
          onClick={() => {
            setCanceling(true);
            // async-boundary: handled - the action reports its own failure and
            // resets the pending label.
            void cancelIrisAgentTask(sessionId, card.taskId).catch(() => setCanceling(false));
          }}
        >
          {canceling
            ? <><LoaderCircle className="mr-1 !size-3 animate-spin" />取消中…</>
            : <><Square className="mr-1 !size-3" />取消</>}
        </Button>
      ) : undefined}
    >
      <div className="space-y-2 px-4 py-3.5 text-xs">
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
          {card.command}
        </pre>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="tabular-nums">{card.outputBytes.toLocaleString()} bytes</span>
          <span>{active ? '输出持续写入日志文件' : '日志已保留在磁盘'}</span>
        </div>
        {card.error && <div className="whitespace-pre-wrap break-words text-destructive">{card.error}</div>}
      </div>
      <div className="flex justify-end border-t border-border/40 bg-muted/10 px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 text-[11px]"
          onClick={() => onOpenTask(card.taskId)}
        >
          <Play className="mr-1 !size-3" />
          打开任务
        </Button>
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
  sessionId,
  message,
  onOpenPrompt,
  artifactTitle,
  onFork,
}: {
  sessionId: string;
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
      {message.attachments && message.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          {message.attachments.map((attachment) => (
            <SentAttachmentImage
              key={attachment.id}
              sessionId={sessionId}
              attachment={attachment}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One image the user attached. The bytes are resolved by id through main, so
 * the renderer never needs — or gets — a path to the stored file.
 */
function SentAttachmentImage({
  sessionId,
  attachment,
}: {
  sessionId: string;
  attachment: IrisAgentAttachment;
}): JSX.Element {
  const { containerRef, dataUrl, failed } = useLazyAttachment(sessionId, attachment.id);

  if (failed) {
    return (
      <div ref={containerRef} className="flex h-16 items-center rounded-md border border-border/70 bg-muted/30 px-2 text-[11px] text-muted-foreground">
        {attachment.name} 已不可读取
      </div>
    );
  }
  return (
    <div ref={containerRef}>
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={attachment.name}
          loading="lazy"
          className="h-16 w-auto max-w-[10rem] rounded-md border border-border/70 object-contain"
        />
      ) : (
        <div className="h-16 w-24 animate-pulse rounded-md border border-border/60 bg-muted/30" aria-hidden="true" />
      )}
    </div>
  );
}

/** Compact size label for a pending attachment chip. */
function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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

function statusLabel(
  state: IrisAgentSessionInfo['state'],
  phase: IrisAgentLivePhase | null,
  thinkingElapsed: number,
): string {
  switch (state) {
    case 'starting':
      return '启动中';
    case 'ready':
      return '就绪';
    case 'running':
      if (phase === 'thinking') return `思考中 · ${thinkingElapsed.toFixed(1)}s`;
      if (phase === 'generating') return '生成中';
      return '请求中';
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

function useThinkingElapsed(startedAt: number | null, active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active || startedAt === null) {
      setElapsed(0);
      return;
    }
    const update = (): void => setElapsed(Math.max(0, Date.now() - startedAt) / 1000);
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  return elapsed;
}
