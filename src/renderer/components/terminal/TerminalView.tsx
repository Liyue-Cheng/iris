/**
 * One mounted xterm per visible session (Marina's state-replay protocol):
 *
 *   mount → subscribe live output into a hold queue → fetch the serialized
 *   full-state replay {data, lastSeq} → write replay (16KB chunks, FLK-1) →
 *   flush queued chunks with seq > lastSeq → fence → scrollToBottom →
 *   reveal host → stream live.
 *
 * Subscribing BEFORE the replay fetch is what closes the gap: bytes arriving
 * during the fetch are queued, then seq-filtered — no loss, no double-write.
 * Switching sessions destroys this view and replays the next one; the main
 * process's headless mirror is the source of truth, so buffers survive any
 * number of remounts (alt-buffer TUIs included).
 *
 * Anti-flicker discipline ported from Marina (SCROLL-1 two rounds): the
 * host stays visibility:hidden + inert until the replay fence callback has
 * anchored the viewport bottom and one RAF has let the renderer paint —
 * the first visible frame is the final state. scrollToBottom must run in
 * the zero-length-write fence, never right after the writes: term.write is
 * an async queue and the "bottom" keeps growing while the parser drains.
 *
 * Clipboard (Marina CPB/PASTE-1/KBD-1): all copy/paste goes through the
 * IPC clipboard bridge (navigator.clipboard silently rejects in the
 * Electron file:// context). Keydown chords are matched against the
 * shared keybinding table; paste itself happens in ONE place — the
 * capture-phase 'paste' listener — so Ctrl+V / Ctrl+Shift+V /
 * Shift+Insert / context menu / voice input share a single path, and
 * xterm's own bubble-phase paste listener (which would shove raw
 * clipboard bytes into the PTY) never fires.
 *
 * Resize discipline (Marina 勘误 #2/#4, XTM-7/8): ResizeObserver →
 * 150ms trailing debounce → fit(); the PTY only hears about dims ≥ 20×5
 * via term.onResize; a pending debounced fit is flushed before any
 * keystroke so the PTY never processes input at stale dims. Real dims
 * are written back to the matching project/layout bucket so the next session
 * in that region spawns at the right size instead of 120×30-then-resize
 * (ConPTY shreds early progress-bar lines on that reflow).
 */
import { useCallback, useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@xterm/xterm/css/xterm.css';
import { pipeline } from '@renderer/cpu';
import type { ProjectScope } from '@shared/types';
import {
  getDocDragPath,
  isDocDrag,
  resolveSystemFilePaths,
} from '@renderer/lib/doc-drag';
import { matchKeybinding } from '@shared/terminal-keybindings';
import { isTerminalFocusReport } from '@shared/terminal/input-policy';
import { writeClipboardText } from '@renderer/lib/clipboard';
import { openExternalUrl } from '@renderer/lib/shell-actions';
import { getSettings, useSettings } from '@renderer/stores/settings-store';
import {
  sessionStore,
  setLastTerminalDims,
  terminalLayoutScope,
  useSessions,
} from '@renderer/stores/session-store';
import { runUserAction } from '@renderer/lib/action-runtime';
import { attachTerminalImeCompatibility } from '@renderer/terminal/xterm-compat';
import { TerminalInputController } from '@renderer/terminal/input-controller';
import { createTerminalInputController } from '@renderer/terminal/input-operation';
import { TerminalReplayController } from '@renderer/terminal/replay-controller';
import { TerminalSessionRuntime } from '@renderer/terminal/terminal-runtime';
import {
  ElectronTerminalTransport,
  getTerminalDroppedFilePath,
} from '@renderer/terminal/terminal-transport';
import { TerminalViewportController } from '@renderer/terminal/viewport-controller';
import {
  BrowserXtermAdapter,
  type BrowserTerminal,
} from '@renderer/terminal/xterm-adapter';
import { TerminalContextMenu } from './TerminalContextMenu';
import { TerminalSearchBar } from './TerminalSearchBar';

const onWindows = navigator.platform.toLowerCase().includes('win');

/** xterm getSelection() yields LF; native Windows apps expect CRLF (CPB-C4). */
function selectionForClipboard(sel: string): string {
  return onWindows ? sel.replace(/\n/g, '\r\n') : sel;
}

const MIN_COLS = 20;
const MIN_ROWS = 5;
const RESIZE_DEBOUNCE_MS = 150;
const REPLAY_CHUNK_BYTES = 16 * 1024;
const REPLAY_FAILSAFE_MS = 5000;

/**
 * Route both detected URLs and OSC 8 hyperlinks through Electron's
 * setWindowOpenHandler. The web-links addon's default handler opens an empty
 * window first and assigns its URL afterwards; our deny-by-default handler
 * rejects that empty window before the assignment can happen.
 */
function openTerminalLink(_event: MouseEvent, uri: string): void {
  // async-boundary: handled - runUserAction reports the failure; this catch keeps link activation void.
  void openExternalUrl(uri).catch(() => undefined);
}

export function TerminalView({ sessionId }: { sessionId: string }): JSX.Element {
  const { t } = useTranslation();
  const { disconnectedSessionIds } = useSessions();
  const disconnected = disconnectedSessionIds.has(sessionId);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<BrowserTerminal | null>(null);
  const xtermAdapterRef = useRef<BrowserXtermAdapter | null>(null);
  const inputControllerRef = useRef<TerminalInputController | null>(null);
  const safeFitRef = useRef<(() => void) | null>(null);
  const searchRef = useRef<BrowserXtermAdapter['search'] | null>(null);
  const settings = useSettings();
  const tRef = useRef(t);
  tRef.current = t;

  // SCROLL-1: hidden (opacity:0, NOT visibility:hidden — see P2 below) until
  // the replay has anchored bottom and the renderer has painted the final
  // state. RightPane keys this component by sessionId, so every session switch
  // starts hidden again.
  const [hostRevealed, setHostRevealed] = useState(false);
  // P2: the terminal can hold keyboard focus the instant xterm opens (textarea
  // exists), BEFORE the scrollback replay finishes — keystrokes go straight to
  // the PTY instead of being dropped during the 100–500ms replay window. This
  // is why the pre-reveal hide is opacity:0 (focusable) not visibility:hidden
  // (its descendants can't be focused), and why the old `inert` is gone:
  // focus is now intent-driven, so keys only reach the terminal when it's the
  // focus target anyway (no leak to leave inert to guard against).
  // Snapshot taken when the context menu opens (the menu itself would
  // steal focus and could race selection state at click time).
  const [ctxHasSelection, setCtxHasSelection] = useState(false);

  // ── search bar (Ctrl+F) ──
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchResults, setSearchResults] = useState<{ matches: number; current: number }>({
    matches: 0,
    current: 0,
  });
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Mirror search state into refs so the long-lived key handler / focus
  // helpers (registered once per mount) always read the latest values.
  const searchVisibleRef = useRef(searchVisible);
  searchVisibleRef.current = searchVisible;
  const searchTextRef = useRef(searchText);
  searchTextRef.current = searchText;
  const searchCaseSensitiveRef = useRef(searchCaseSensitive);
  searchCaseSensitiveRef.current = searchCaseSensitive;

  // ── copy / paste / clear ──
  const handleCopy = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const sel = term.getSelection();
    if (sel) void writeClipboardText(selectionForClipboard(sel));
    // CPB-C1: hand focus back so typing keeps working after a menu copy.
    term.focus();
  }, []);

  /** The single paste body — clipboard paste and doc-drop both end here. */
  const handlePaste = useCallback(async () => {
    await inputControllerRef.current?.pasteClipboard();
  }, []);

  /**
   * Drop of OS files (dragged from Explorer/Finder): send the (quoted)
   * paths to the PTY, space-separated — Windows Terminal behavior. Goes
   * straight to SESSION_INPUT, not through term.paste: a dropped path is a
   * command argument the user is composing, not clipboard content. NTFS
   * allows shell metacharacters in filenames (`foo;rm -rf x`), so a path
   * with any is confirmed first (Marina SEC-5).
   */
  const handleFileDrop = useCallback(
    async (paths: string[]) => {
      await inputControllerRef.current?.dropPaths(paths);
    },
    [],
  );

  /** Drop of a doc row: paste its relative path or a fresh content snapshot. */
  const handleDocDrop = useCallback(
    async (docPath: string) => {
      await runUserAction(
        {
          title: t('errors.terminalDropFailed'),
          dedupeKey: `terminal:doc-drop:${sessionId}`,
        },
        async () => {
          await inputControllerRef.current?.dropDocument(docPath);
        },
      );
      termRef.current?.focus();
    },
    [sessionId, t],
  );

  const handleClear = useCallback(() => {
    termRef.current?.clear();
    termRef.current?.focus();
  }, []);

  // ── search ──
  const handleOpenSearch = useCallback(() => {
    setSearchVisible(true);
    // The input mounts this render; focus on the next frame once it exists.
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const handleCloseSearch = useCallback(() => {
    try {
      searchRef.current?.clearDecorations();
    } catch {
      /* ignore */
    }
    setSearchVisible(false);
    setSearchText('');
    setSearchResults({ matches: 0, current: 0 });
    termRef.current?.focus();
  }, []);

  // Read the latest query/case from refs — a useCallback closure would pin the
  // value at mount and "Enter searches the previous keyword" (Marina #8).
  const performSearch = useCallback((direction: 'next' | 'previous') => {
    const search = searchRef.current;
    const text = searchTextRef.current;
    if (!search || !text) return;
    const opts = {
      caseSensitive: searchCaseSensitiveRef.current,
      decorations: {
        matchBackground: '#7d6c00',
        matchOverviewRuler: '#f6c177',
        activeMatchBackground: '#bd6500',
        activeMatchColorOverviewRuler: '#eb6f92',
      },
    };
    if (direction === 'next') search.findNext(text, opts);
    else search.findPrevious(text, opts);
  }, []);

  // Ctrl+wheel font resize (8–24px). Applies locally on the live term for
  // instant feedback, then persists via a trailing 120ms debounce so a fast
  // scroll doesn't fire one settings.update per tick (each would rebuild every
  // terminal's metrics). pendingFontSizeRef carries the in-flight value so
  // successive ticks accumulate before the term reads it back from settings.
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFontSizeRef = useRef<number | null>(null);
  const handleWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    const current = pendingFontSizeRef.current ?? getSettings()?.appearance.terminalFontSize ?? 13;
    const next = Math.max(8, Math.min(24, current + (e.deltaY < 0 ? 1 : -1)));
    if (next === current) return;
    pendingFontSizeRef.current = next;
    term.options.fontSize = next; // instant visual feedback
    safeFitRef.current?.();
    if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = setTimeout(() => {
      wheelTimerRef.current = null;
      const settled = pendingFontSizeRef.current;
      pendingFontSizeRef.current = null;
      if (settled == null) return;
      void runUserAction(
        {
          title: t('errors.settingsPersistenceFailed'),
          dedupeKey: 'settings:terminal-font-size',
        },
        () => pipeline.dispatch('settings.update', {
          appearance: { terminalFontSize: settled },
        }),
      ).then((outcome) => {
        if (outcome.status !== 'failed') return;
        const persisted = getSettings()?.appearance.terminalFontSize ?? 13;
        const currentTerm = termRef.current;
        if (!currentTerm) return;
        currentTerm.options.fontSize = persisted;
        safeFitRef.current?.();
      });
    }, 120);
  }, [t]);

  // The custom key handler and paste interceptor are registered once per
  // mount; route them through a ref so they always see the latest handlers.
  const handlersRef = useRef({
    handleCopy,
    handlePaste,
    handleClear,
    handleOpenSearch,
    handleCloseSearch,
  });
  handlersRef.current = {
    handleCopy,
    handlePaste,
    handleClear,
    handleOpenSearch,
    handleCloseSearch,
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const sessionScope = scopeForSession(sessionId);
    if (!sessionScope) return;

    const s = getSettings();
    const themeId = s?.appearance.theme;
    const runtime = new TerminalSessionRuntime(sessionId, sessionScope);
    const transport = new ElectronTerminalTransport(sessionId, sessionScope, runtime.epoch);
    runtime.own(() => {
      void transport.detach().catch(() => undefined);
    });
    const xtermAdapter = new BrowserXtermAdapter({
      fontFamily:
        s?.appearance.terminalFontFamily ??
        "'Cascadia Mono', 'JetBrains Mono', 'Consolas', monospace",
      fontSize: s?.appearance.terminalFontSize ?? 13,
      lineHeight: s?.appearance.terminalLineHeight ?? 1.2,
      themeId,
      renderer: s?.advanced.terminalRenderer ?? 'auto',
      windowsBuild: transport.windowsBuild,
      openLink: openTerminalLink,
    });
    const term = xtermAdapter.terminal;
    xtermAdapterRef.current = xtermAdapter;
    termRef.current = term;

    let disposed = false;
    runtime.transition({ type: 'ATTACH' });
    const inputController = createTerminalInputController({
      runtime,
      transport,
      terminal: term,
      getTranslate: () => tRef.current,
    });
    inputControllerRef.current = inputController;

    // KBD-1: scan the shared binding table; consume matches so xterm never
    // encodes them as control bytes (unhandled Ctrl+V becomes 0x16 to the
    // PTY — the root cause of "paste does nothing"). IME composition passes
    // everything through untouched.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.isComposing || ev.keyCode === 229) return true;
      const binding = matchKeybinding(ev, { searchVisible: searchVisibleRef.current });
      if (!binding) return true;
      const h = handlersRef.current;
      switch (binding.action) {
        case 'open-search':
          h.handleOpenSearch();
          return false;
        case 'close-search':
          h.handleCloseSearch();
          return false;
        case 'copy-or-sigint': {
          // Selection → copy + clear (CPB-C3: a lingering selection would
          // make every later Ctrl+C copy instead of interrupting); none →
          // pass through as SIGINT.
          if (!term.getSelection()) return true;
          h.handleCopy();
          term.clearSelection();
          return false;
        }
        case 'copy-and-clear': {
          if (term.getSelection()) {
            h.handleCopy();
            term.clearSelection();
          }
          return false;
        }
        case 'consume-for-paste':
          // The browser fires 'paste' next; the capture-phase listener is
          // the single entry point for the actual paste.
          return false;
        default: {
          const _exhaustive: never = binding.action;
          void _exhaustive;
          return true;
        }
      }
    });

    const viewport = new TerminalViewportController(
      { fit: () => xtermAdapter.fit.fit() },
      RESIZE_DEBOUNCE_MS,
    );
    runtime.own(() => viewport.dispose());

    // SearchAddon (Ctrl+F). onDidChangeResults feeds the "x / N" hit counter;
    // registerDecoration (match highlight + overview-ruler markers) needs
    // allowProposedApi, already true above.
    const searchAddon = xtermAdapter.search;
    searchRef.current = searchAddon;
    const searchResultsDisposable = searchAddon.onDidChangeResults?.((results) => {
      if (!results) {
        setSearchResults({ matches: 0, current: 0 });
        return;
      }
      const count = results.resultCount ?? 0;
      const idx = results.resultIndex ?? -1;
      setSearchResults({ matches: count, current: count > 0 && idx >= 0 ? idx + 1 : 0 });
    });

    xtermAdapter.open(host);

    // PASTE-1: capture-phase paste interceptor — the only paste entry.
    // Stops xterm's bubble-phase listener from writing raw clipboard bytes
    // to the PTY, and funnels every source (keys, menu, voice input)
    // through handlePaste. Registered on the helper textarea (xterm's
    // paste target) with the host as a fallback layer.
    const pasteInterceptor = (evt: ClipboardEvent): void => {
      evt.stopImmediatePropagation();
      evt.preventDefault();
      void handlersRef.current.handlePaste();
    };
    const helperTa = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    helperTa?.addEventListener('paste', pasteInterceptor, true);
    host.addEventListener('paste', pasteInterceptor, true);

    // IME-1/IME-2 (Marina, same xterm build): compositionend backlog
    // cleaner + candidate-window position lock. Both degrade gracefully if
    // xterm's internals move.
    const detachImeCompatibility = attachTerminalImeCompatibility(term, helperTa);

    // CPB-C2: select-on-copy with a trailing debounce — drag-selecting 50
    // chars must not fire 50 clipboard writes (Windows OLE lock makes
    // clipboard managers flicker). Gated live on behavior.selectOnCopy.
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    const selectionDisposable = term.onSelectionChange(() => {
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        selectionTimer = null;
        if (!(getSettings()?.behavior.selectOnCopy ?? true)) return;
        const sel = term.getSelection();
        if (sel) void writeClipboardText(selectionForClipboard(sel));
      }, 100);
    });

    // ── resize plumbing ──
    // term.onResize is the single PTY notification point: every fit() that
    // actually changes dims (mount, RO, font change, webfont ready) lands
    // here exactly once. XTM-8 guard: dims below 20×5 are layout-shuffle
    // noise — never told to the PTY.
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (cols < MIN_COLS || rows < MIN_ROWS) return;
      const session = sessionStore.get().sessions.find((candidate) => candidate.id === sessionId);
      if (session) {
        setLastTerminalDims(session.projectRoot, terminalLayoutScope(session), { cols, rows });
      }
      if (viewport.replayInProgress) return;
      void transport.resize(cols, rows).catch(() => undefined);
    });

    safeFitRef.current = () => viewport.requestFit();

    // 勘误 #4: trailing debounce — dragging the pane sash fires dozens of
    // RO callbacks per second, and every one used to hit ConPTY with a
    // reflow (progress bars get shredded into junk lines).
    viewport.observe(host);

    // RSZ-2: maximize/restore is an instant jump, not a drag — skip the
    // debounce (one frame for the chrome layout to settle).
    const unsubscribeMax = transport.onWindowMaximized(() => {
      if (disposed) return;
      requestAnimationFrame(() => {
        if (!disposed) viewport.requestFit();
      });
    });

    // XTM-9: metrics measured against a fallback font are wrong until the
    // webfont (霞鹜文楷 etc.) is in; re-fit once it lands.
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready
        .then(() => {
          if (!disposed) viewport.requestFit();
        })
        .catch(() => {
          // Font readiness is an optional metric refinement; the fallback font remains usable.
        });
    }

    const replayController = new TerminalReplayController(
      runtime,
      transport,
      {
        get cols() {
          return term.cols;
        },
        get rows() {
          return term.rows;
        },
        write: (data, callback) => term.write(data, callback),
        scrollToBottom: () => term.scrollToBottom(),
        beginSynchronizedReplay: () => xtermAdapter.beginSynchronizedReplay(),
        endSynchronizedReplay: (callback) => xtermAdapter.endSynchronizedReplay(callback),
      },
      viewport,
      {
        chunkBytes: REPLAY_CHUNK_BYTES,
        timeoutMs: REPLAY_FAILSAFE_MS,
        reveal: () => setHostRevealed(true),
        warn: (message, error) => console.warn(message, error),
      });

    // Subscribe before requesting replay so the controller can close the live-output gap.
    const unsubscribe = transport.onOutput((payload) => replayController.onOutput(payload));

    let alternateSelectionGesture = false;
    let alternateSelectionFrozen = false;
    const resumeAlternateSelection = (): void => {
      if (!alternateSelectionFrozen) return;
      alternateSelectionFrozen = false;
      void replayController.resumeFromHistory().catch(() => undefined);
    };
    const beginAlternateSelection = (event: MouseEvent): void => {
      const selectsText = term.modes.mouseTrackingMode === 'none' || event.shiftKey;
      if (event.button !== 0 || term.buffer.active.type !== 'alternate' || !selectsText) return;
      alternateSelectionGesture = true;
      alternateSelectionFrozen = true;
      replayController.freezeHistory();
    };
    const endAlternateSelection = (): void => {
      if (!alternateSelectionGesture) return;
      alternateSelectionGesture = false;
      requestAnimationFrame(() => {
        if (!term.hasSelection()) resumeAlternateSelection();
      });
    };
    host.addEventListener('mousedown', beginAlternateSelection, true);
    document.addEventListener('mouseup', endAlternateSelection, true);

    const selectionFreezeDisposable = term.onSelectionChange(() => {
      if (term.buffer.active.type === 'alternate' && term.hasSelection()) {
        alternateSelectionFrozen = true;
        replayController.freezeHistory();
      } else if (!alternateSelectionGesture) {
        resumeAlternateSelection();
      }
    });

    const dataDisposable = term.onData((data) => {
      viewport.flushBeforeInput();
      if (
        runtime.state.phase === 'history-frozen' &&
        !isTerminalFocusReport(data) &&
        !alternateSelectionGesture &&
        !term.hasSelection()
      ) {
        term.scrollToBottom();
        void replayController.resumeFromHistory().catch(() => undefined);
      }
      void transport.sendInput(data).catch(() => undefined);
    });
    const scrollDisposable = term.onScroll(() => {
      if (term.buffer.active.type !== 'normal') return;
      const buffer = term.buffer.active;
      if (buffer.viewportY >= buffer.baseY) {
        void replayController.resumeFromHistory().catch(() => undefined);
      } else {
        replayController.freezeHistory();
      }
    });

    // async-boundary: handled - TerminalReplayController owns catch/fallback and epoch checks.
    void replayController.start();

    return () => {
      disposed = true;
      runtime.dispose();
      if (selectionTimer !== null) clearTimeout(selectionTimer);
      unsubscribe();
      unsubscribeMax();
      dataDisposable.dispose();
      scrollDisposable.dispose();
      selectionFreezeDisposable.dispose();
      resizeDisposable.dispose();
      selectionDisposable.dispose();
      detachImeCompatibility();
      helperTa?.removeEventListener('paste', pasteInterceptor, true);
      host.removeEventListener('paste', pasteInterceptor, true);
      host.removeEventListener('mousedown', beginAlternateSelection, true);
      document.removeEventListener('mouseup', endAlternateSelection, true);
      searchResultsDisposable?.dispose();
      xtermAdapter.dispose();
      termRef.current = null;
      xtermAdapterRef.current = null;
      inputControllerRef.current = null;
      safeFitRef.current = null;
      searchRef.current = null;
    };
    // Recreate only per session — theme/font changes apply via the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Flush any pending Ctrl+wheel font-size write on unmount.
  useEffect(() => {
    return () => {
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
    };
  }, []);

  // Live search: each query/case change re-runs findNext so the hit counter
  // updates per keystroke; clearing the query drops the highlights.
  useEffect(() => {
    const search = searchRef.current;
    if (!search || !searchVisible) return;
    if (!searchText) {
      try {
        search.clearDecorations();
      } catch {
        /* ignore */
      }
      setSearchResults({ matches: 0, current: 0 });
      return;
    }
    performSearch('next');
  }, [searchText, searchCaseSensitive, searchVisible, performSearch]);

  // Live theme/font switching without remount (xterm supports runtime opts).
  useEffect(() => {
    const adapter = xtermAdapterRef.current;
    if (!adapter || !settings) return;
    adapter.updateAppearance({
      themeId: settings.appearance.theme,
      fontFamily: settings.appearance.terminalFontFamily,
      fontSize: settings.appearance.terminalFontSize,
      lineHeight: settings.appearance.terminalLineHeight,
    });
    safeFitRef.current?.(); // metrics changed → re-measure (PTY hears via onResize)
  }, [settings]);

  return (
    <div className="relative h-full w-full">
      {disconnected && (
        <div role="alert" className="absolute inset-x-0 top-0 z-40 border-b border-destructive/30 bg-destructive/90 px-3 py-1.5 text-xs text-destructive-foreground">
          {t('errors.sessionDisconnected')}
        </div>
      )}
      <TerminalContextMenu
        hasSelection={ctxHasSelection}
        onCopy={handleCopy}
        onPaste={() => void handlePaste()}
        onClear={handleClear}
        onSearch={handleOpenSearch}
        onOpenChange={(open) => {
          if (open) {
            setCtxHasSelection(!!termRef.current?.getSelection());
          } else if (!searchVisibleRef.current) {
            // Menu close drops focus on body; hand it back to the terminal
            // (unless the search bar owns focus).
            requestAnimationFrame(() => termRef.current?.focus());
          }
        }}
      >
        <div
            ref={hostRef}
            className="h-full w-full px-1 pt-1"
            // P2: opacity (not visibility) keeps the host focusable while the
            // replay paints under cover, so the terminal can take keyboard
            // focus and feed the PTY before reveal. Reveal still happens only
            // after the fence + RAF, so the first VISIBLE frame is the final
            // state (SCROLL-1 anti-flicker intact).
            style={hostRevealed ? undefined : { opacity: 0 }}
          // behavior.terminalRightClick='paste': preventDefault makes Radix's
          // composed trigger handler bail (defaultPrevented check), so the
          // menu never opens — right click goes straight to the single paste
          // path instead. Read live so the setting applies without remount.
          onContextMenu={(e) => {
            if ((getSettings()?.behavior.terminalRightClick ?? 'menu') === 'paste') {
              e.preventDefault();
              void handlersRef.current.handlePaste();
            }
          }}
          onWheel={handleWheel}
          onDragOver={(e) => {
            // Internal doc drag OR an OS file drag both drop here.
            if (isDocDrag(e.dataTransfer) || e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            const docPath = getDocDragPath(e.dataTransfer);
            if (docPath) {
              e.preventDefault();
              void handleDocDrop(docPath);
              return;
            }
            // OS file drop: paste the (quoted) paths as a command argument.
            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) {
              e.preventDefault();
              const paths = resolveSystemFilePaths(files, getTerminalDroppedFilePath);
              if (paths.length > 0) void handleFileDrop(paths);
            }
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
          onClose={handleCloseSearch}
        />
      )}
    </div>
  );
}
function scopeForSession(sessionId: string): ProjectScope | null {
  const session = sessionStore.get().sessions.find((candidate) => candidate.id === sessionId);
  return session
    ? { root: session.projectRoot, generation: session.projectGeneration }
    : null;
}
