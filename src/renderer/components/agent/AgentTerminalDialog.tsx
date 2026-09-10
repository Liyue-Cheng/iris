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
  AgentStatusBadge,
  AgentWorkbenchDialog,
} from '@renderer/components/agent/AgentWorkbenchDialog';
import { terminalStatusLabel, terminalStatusTone } from '@renderer/lib/agent-status';
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
    <AgentWorkbenchDialog
      icon={<SquareTerminal className="h-4 w-4" />}
      title={terminal.command.trim() || 'Terminal'}
      titleLabel={terminal.command}
      monoTitle
      badge={<AgentStatusBadge tone={terminalStatusTone(terminal)} label={terminalStatusLabel(terminal)} />}
      subtitle={<span className="truncate">{terminal.cwd}</span>}
      subtitleLabel={terminal.cwd}
      onClose={onClose}
    >
      <AgentTerminalPane sessionId={sessionId} terminal={terminal} />
    </AgentWorkbenchDialog>
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
