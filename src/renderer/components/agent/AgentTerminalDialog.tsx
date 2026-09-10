/**
 * Agent terminal dialog — the single surface for one Iris Agent command PTY.
 *
 * The in-panel tab strip is gone: the header terminal icon and the command
 * card's "查看终端输出" both open this dialog. Closing only unmounts the
 * xterm view; main keeps the live PTY (or its retained mirror) so reopening
 * replays the full output from the start.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import type { IrisAgentTerminalView, ProjectScope } from '@shared/types';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@renderer/components/ui/dialog';
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
import { writeIrisAgentTerminal } from '@renderer/lib/iris-agent-actions';

export function AgentTerminalDialog({
  sessionId,
  terminal,
  onClose,
}: {
  sessionId: string;
  terminal: IrisAgentTerminalView;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[min(760px,78vh)] w-[min(1100px,92vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:rounded-xl"
      >
        <header className="flex shrink-0 items-center gap-3 border-b bg-card/70 px-4 py-2.5 pr-12">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <SquareTerminal className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <DialogTitle
                className="min-w-0 truncate font-mono text-[13px] font-medium leading-5"
                aria-label={terminal.command}
              >
                {terminal.command.trim() || 'Terminal'}
              </DialogTitle>
              <TerminalStateBadge terminal={terminal} />
            </div>
            <div
              className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
              aria-label={terminal.cwd}
            >
              {terminal.cwd}
            </div>
          </div>
        </header>
        <div className="relative min-h-0 flex-1">
          <AgentTerminalPane sessionId={sessionId} terminal={terminal} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TerminalStateBadge({ terminal }: { terminal: IrisAgentTerminalView }): JSX.Element {
  if (terminal.state === 'running') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
        <span
          className="iris-agent-terminal-dot h-1.5 w-1.5 rounded-full bg-emerald-500"
          data-running="true"
          aria-hidden="true"
        />
        运行中
      </span>
    );
  }
  const state = terminalState(terminal);
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${state.tone}`}>
      {state.label}
    </span>
  );
}

function terminalState(terminal: IrisAgentTerminalView): { label: string; tone: string } {
  const neutral = 'border-border bg-muted/60 text-muted-foreground';
  const success = 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
  const failure = 'border-destructive/30 bg-destructive/10 text-destructive';
  if (terminal.outcome === 'timeout') return { label: '已超时', tone: failure };
  if (terminal.outcome === 'canceled') return { label: '已取消', tone: neutral };
  if (terminal.outcome === 'launch-failed') return { label: '启动失败', tone: failure };
  if (terminal.exitCode === undefined || terminal.exitCode === null) {
    return { label: '已结束', tone: neutral };
  }
  return {
    label: `退出码 ${terminal.exitCode}`,
    tone: terminal.exitCode === 0 ? success : failure,
  };
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
    <div className="relative h-full min-h-0 bg-background">
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
