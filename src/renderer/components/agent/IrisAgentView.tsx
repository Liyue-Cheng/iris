import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  IrisAgentTerminalView,
  ProjectScope,
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
  writeIrisAgentTerminal,
  continueIrisAgentTerminalSupervision,
} from '@renderer/lib/iris-agent-actions';
import { BrowserXtermAdapter } from '@renderer/terminal/xterm-adapter';
import { IrisAgentTerminalTransport } from '@renderer/terminal/terminal-transport';
import { TerminalReplayController } from '@renderer/terminal/replay-controller';
import { TerminalSessionRuntime } from '@renderer/terminal/terminal-runtime';
import { TerminalViewportController } from '@renderer/terminal/viewport-controller';
import { TerminalContextMenu } from '@renderer/components/terminal/TerminalContextMenu';
import { TerminalSurface } from '@renderer/components/terminal/TerminalSurface';
import { TerminalSearchBar } from '@renderer/components/terminal/TerminalSearchBar';
import { readClipboardText, writeClipboardText } from '@renderer/lib/clipboard';
import { getSettings, useSettings } from '@renderer/stores/settings-store';
import { projectScopeState } from '@renderer/stores/project-scope-state';
import { irisAgentSessionKey } from '@renderer/lib/session-projection';
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
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);
  const [hiddenTerminalIds, setHiddenTerminalIds] = useState<Set<string>>(() => new Set());
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
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
    if (draft.trim() === '' || !selectedModelAvailable) return;
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
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">Iris Agent</div>
          <div className="truncate text-[11px] text-muted-foreground">{statusText}</div>
        </div>
        {modelError && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            title={models.length > 0 ? '部分供应商模型加载失败，点击查看详情' : '模型加载失败，点击查看详情'}
            onClick={() => setShowErrorDialog(true)}
          >
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          </Button>
        )}
        <select
          value={selectedModelValue}
          disabled={running || models.length === 0}
          aria-label="Provider and model"
          title={modelError ?? 'Provider and model'}
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
        {!running && session.canRewindLatestIntent && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => void rewindIrisAgent(session.id)}
            title="回退最后一项意图及可安全还原的文件改动"
            aria-label="回退上一项意图"
          >
            <Undo2 className="!size-3.5" />
          </Button>
        )}
      </div>

      {visibleTerminals.length > 0 && (
        <div className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b bg-muted/20 px-2 pt-1">
          <button
            type="button"
            className={`h-9 shrink-0 rounded-t-sm border-b-2 px-3 text-xs font-medium transition-colors ${selectedTerminal ? 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground' : 'border-primary bg-background text-foreground'}`}
            onClick={() => setSelectedTerminalId(null)}
          >
            对话
          </button>
          {visibleTerminals.map((terminal) => (
            <button
              key={terminal.id}
              type="button"
              className={`flex h-9 max-w-52 shrink-0 items-center gap-1.5 rounded-t-sm border-b-2 px-2.5 text-xs transition-colors ${selectedTerminal?.id === terminal.id ? 'border-primary bg-background text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
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
                      card={group.card}
                      canRetry={false}
                      onRetry={() => undefined}
                      {...(group.card.kind === 'agent-reply' && intent.canFork ? { onFork: () => {
                        branchIrisAgent(session.id, intent.id).then((forked) => {
                          if (forked) onForked?.(forked);
                        }).catch(() => undefined);
                      } } : {})}
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
  const adapterRef = useRef<BrowserXtermAdapter | null>(null);
  const settings = useSettings();
  const [hostRevealed, setHostRevealed] = useState(false);
  const [contextHasSelection, setContextHasSelection] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchResults, setSearchResults] = useState({ matches: 0, current: 0 });
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    adapterRef.current?.search.clearDecorations();
    adapterRef.current?.terminal.focus();
  }, []);

  const performSearch = useCallback((direction: 'next' | 'previous') => {
    const search = adapterRef.current?.search;
    if (!search || !searchText) return;
    const options = { caseSensitive: searchCaseSensitive };
    if (direction === 'next') search.findNext(searchText, options);
    else search.findPrevious(searchText, options);
  }, [searchCaseSensitive, searchText]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scope: ProjectScope | null = projectScopeState.get();
    if (!scope) return;
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
    adapterRef.current = adapter;
    adapter.open(host);
    const term = adapter.terminal;
    const runtime = new TerminalSessionRuntime(`${sessionId}:${terminal.id}`, scope);
    const viewport = new TerminalViewportController(adapter.fit, 150);
    const transport = new IrisAgentTerminalTransport(sessionId, terminal.id, scope);
    const replayController = new TerminalReplayController(runtime, transport, {
      get cols() { return term.cols; },
      get rows() { return term.rows; },
      write: (data, callback) => term.write(data, callback),
      scrollToBottom: () => term.scrollToBottom(),
      beginSynchronizedReplay: () => adapter.beginSynchronizedReplay(),
      endSynchronizedReplay: (callback) => adapter.endSynchronizedReplay(callback),
    }, viewport, {
      chunkBytes: 16 * 1024,
      timeoutMs: 5000,
      reveal: () => setHostRevealed(true),
      warn: (message, error) => console.warn(message, error),
    });
    viewport.observe(host);
    const unsubscribe = transport.onOutput((payload) => replayController.onOutput(payload));
    const dataDisposable = term.onData((data) => {
      viewport.flushBeforeInput();
      void transport.sendInput(data).catch(() => undefined);
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (cols < 20 || rows < 5) return;
      if (viewport.replayInProgress) return;
      void transport.resize(cols, rows).catch(() => undefined);
    });
    const searchDisposable = adapter.search.onDidChangeResults?.((results) => {
      const matches = results?.resultCount ?? 0;
      const index = results?.resultIndex ?? -1;
      setSearchResults({ matches, current: matches > 0 && index >= 0 ? index + 1 : 0 });
    });
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        setSearchVisible(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return false;
      }
      return true;
    });
    // async-boundary: handled - replay controller degrades and reveals on transport failure.
    void replayController.start().catch(() => undefined);
    return () => {
      unsubscribe();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      searchDisposable?.dispose();
      runtime.dispose();
      viewport.dispose();
      // async-boundary: handled - detach is best-effort during unmount.
      void transport.detach().catch(() => undefined);
      transport.dispose();
      adapter.dispose();
      adapterRef.current = null;
    };
  }, [sessionId, terminal.id]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || !settings) return;
    adapter.updateAppearance({
      themeId: settings.appearance.theme,
      fontFamily: settings.appearance.terminalFontFamily,
      fontSize: settings.appearance.terminalFontSize,
      lineHeight: settings.appearance.terminalLineHeight,
    });
    adapter.fit.fit();
  }, [settings]);

  useEffect(() => {
    const search = adapterRef.current?.search;
    if (!search || !searchVisible) return;
    if (!searchText) {
      search.clearDecorations();
      setSearchResults({ matches: 0, current: 0 });
      return;
    }
    performSearch('next');
  }, [performSearch, searchText, searchVisible]);

  const copySelection = (): void => {
    const term = adapterRef.current?.terminal;
    if (!term) return;
    const selection = term.getSelection();
    if (selection) void writeClipboardText(selection);
    term.focus();
  };

  const pasteClipboard = (): void => {
    // async-boundary: handled - clipboard helper reports read failures and terminal input handles its rejection.
    void readClipboardText().then((text) => {
      if (text === null) return;
      void writeIrisAgentTerminal(sessionId, terminal.id, text).catch(() => undefined);
      adapterRef.current?.terminal.focus();
    });
  };

  return (
    <div className="relative min-h-0 flex-1 bg-background">
      <TerminalContextMenu
        hasSelection={contextHasSelection}
        onCopy={copySelection}
        onPaste={pasteClipboard}
        onClear={() => {
          adapterRef.current?.terminal.clear();
          adapterRef.current?.terminal.focus();
        }}
        onSearch={() => {
          setSearchVisible(true);
          requestAnimationFrame(() => searchInputRef.current?.focus());
        }}
        onOpenChange={(open) => {
          if (open) setContextHasSelection(!!adapterRef.current?.terminal.getSelection());
          else if (!searchVisible) requestAnimationFrame(() => adapterRef.current?.terminal.focus());
        }}
      >
        <TerminalSurface
          hostRef={hostRef}
          revealed={hostRevealed}
          onContextMenu={(event) => {
            if ((getSettings()?.behavior.terminalRightClick ?? 'menu') !== 'paste') return;
            event.preventDefault();
            pasteClipboard();
          }}
        />
      </TerminalContextMenu>
      {searchVisible && (
        <TerminalSearchBar
          inputRef={searchInputRef}
          text={searchText}
          caseSensitive={searchCaseSensitive}
          results={searchResults}
          onTextChange={setSearchText}
          onCaseSensitiveChange={setSearchCaseSensitive}
          onSearch={performSearch}
          onClose={closeSearch}
        />
      )}
    </div>
  );
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
  onFork,
}: {
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
          title={expanded ? '收起获取记录' : '展开全部获取记录'}
          aria-label={expanded ? '收起获取记录' : '展开全部获取记录'}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="!size-3.5" /> : <ChevronRight className="!size-3.5" />}
        </Button>
      ) : undefined}
    >
      <div className="divide-y divide-border/60 bg-[var(--iris-card-retrievals)]/[0.02]">
        {!expanded && card.items.length > 5 && (
          <div className="border-t border-border/40 bg-muted/10 px-4 py-2 text-center text-[11px] text-muted-foreground">
            另有 {card.items.length - 5} 项
          </div>
        )}
        {visibleItems.map((item) => (
          <div key={item.id} className="min-w-0 px-4 py-2.5 text-xs">
            <div className="flex min-w-0 items-start gap-2.5">
              {item.kind === 'file'
                ? <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--iris-card-retrievals)]" />
                : <SquareTerminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--iris-card-retrievals)]" />}
              <div className="min-w-0 flex-1">
                <div className="break-all font-mono text-[11px] text-foreground">{item.label}</div>
                <div className={`mt-1 flex items-center gap-1.5 text-[11px] ${item.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
                  <RetrievalStateIcon state={item.state} />
                  <span>{retrievalStateLabel(item.state)}</span>
                </div>
                {item.state === 'failed' && item.error && (
                  <details className="mt-1.5 text-[11px] text-destructive">
                    <summary className="cursor-pointer select-none font-medium">展开失败原因</summary>
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
      <div className="divide-y divide-border/60 border-t bg-[var(--iris-card-files)]/[0.02]">
        {cards.map((card) => {
          const stats = diffLineStats(card.diff);
          const action = card.action === 'created' ? '创建' : card.action === 'updated' ? '修改' : card.action === 'unchanged' ? '未改变' : '写入失败';
          return (
            <div key={card.id} className="flex min-h-9 items-center gap-2 px-4 py-2 text-xs">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={card.path}>{card.path}</span>
              {(stats.additions || stats.deletions) ? (
                <span className="shrink-0 font-mono text-[11px] font-semibold">
                  <span className="text-emerald-600 dark:text-emerald-400">+{stats.additions}</span>
                  {' '}
                  <span className="text-red-600 dark:text-red-400">-{stats.deletions}</span>
                </span>
              ) : (
                <span className="shrink-0 text-[11px] text-muted-foreground">{action}</span>
              )}
              {card.error && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label={card.error} />}
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
          title={expanded ? '收起命令' : '展开完整命令'}
          aria-label={expanded ? '收起命令' : '展开完整命令'}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="!size-3.5" /> : <ChevronRight className="!size-3.5" />}
        </Button>
      ) : undefined}
    >
      <pre
        className={`${expanded ? 'max-h-none' : 'max-h-40'} overflow-auto border-t bg-[var(--iris-card-operations)]/[0.02] p-4 whitespace-pre-wrap break-words font-mono text-xs leading-5`}
        aria-label="执行命令"
      >
        {card.command}
      </pre>
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
          title="从此回复创建对话分支"
          aria-label="从此回复创建对话分支"
          onClick={onFork}
        >
          <GitBranch className="!size-3.5" />
        </Button>
      ) : undefined}
    >
      <div className="markdown-body min-w-0 border-t bg-[var(--iris-card-message)]/[0.02] px-4 py-3 text-[13px] leading-relaxed">
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

type CardType = 'files' | 'operations' | 'retrievals' | 'message';

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
  // 根据状态决定边框和背景样式
  const getStateStyles = () => {
    if (state === 'running') {
      return 'border-2 border-[var(--iris-card-' + cardType + ')] bg-[var(--iris-card-' + cardType + ')]/[0.03]';
    }
    if (state === 'completed' || state === 'unchanged') {
      return 'border-l-[3px] border-l-emerald-500/70 border-t border-r border-b border-border/80 bg-emerald-500/[0.03]';
    }
    if (state === 'failed') {
      return 'border-l-[4px] border-l-destructive border-t border-r border-b border-border/80 bg-destructive/[0.05]';
    }
    if (state === 'partial') {
      return 'border-l-[3px] border-l-amber-500 border-t border-r border-b border-border/80 bg-amber-500/[0.03]';
    }
    if (state === 'stopped') {
      return 'border border-border/60 bg-muted/[0.02]';
    }
    return 'border border-border/80';
  };

  // 顶栏渐变背景
  const headerGradient = {
    files: 'linear-gradient(135deg, var(--iris-card-files-from) 0%, var(--iris-card-files-to) 100%)',
    operations: 'linear-gradient(135deg, var(--iris-card-operations-from) 0%, var(--iris-card-operations-to) 100%)',
    retrievals: 'linear-gradient(135deg, var(--iris-card-retrievals-from) 0%, var(--iris-card-retrievals-to) 100%)',
    message: 'linear-gradient(135deg, var(--iris-card-message-from) 0%, var(--iris-card-message-to) 100%)',
  };

  return (
    <section className={`iris-agent-card overflow-hidden rounded-lg ${getStateStyles()} transition-all duration-200 animate-[iris-card-enter_0.25s_ease-out]`} aria-label={title}>
      <div
        className="flex min-h-10 items-center gap-2 px-4 py-2"
        style={{ background: headerGradient[cardType], opacity: 0.85 }}
      >
        <span className="shrink-0 text-white/90">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="shrink-0 text-[13px] font-semibold text-white">{title}</h3>
            {summary && (
              <span className="min-w-0 truncate text-[11px] text-white/70" title={summary}>
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
    return <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-white/80" aria-label="运行中" />;
  }
  if (state === 'failed') {
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-white/90" aria-label="失败" />;
  }
  if (state === 'partial') {
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-white/90" aria-label="部分失败" />;
  }
  if (state === 'stopped') {
    return <Square className="h-3 w-3 shrink-0 text-white/80" aria-label="已停止" />;
  }
  return <Check className="h-3.5 w-3.5 shrink-0 text-white/90" aria-label={state === 'unchanged' ? '无变化' : '完成'} />;
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
  onFork,
}: {
  message: IrisAgentUserView;
  onOpenPrompt: (() => void) | undefined;
  artifactTitle: string | undefined;
  onFork?: (() => void) | undefined;
}): JSX.Element {
  return (
    <div className="rounded-md bg-muted px-3 py-2 text-sm">
      <div className="mb-1 flex h-6 items-start justify-between gap-2">
        <span className="text-[11px] font-medium uppercase text-muted-foreground">You</span>
        <div className="flex items-center gap-1">
        {onFork && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mr-1 -mt-1 h-6 w-6 shrink-0 text-muted-foreground"
            title="从此输入重新开始"
            aria-label="从此输入重新开始"
            onClick={onFork}
          >
            <GitBranch className="!size-3.5" />
          </Button>
        )}
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
      </div>
      <div className="whitespace-pre-wrap break-words">{message.content}</div>
    </div>
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
