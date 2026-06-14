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
 * the write('', cb) fence, never right after the writes: term.write is an
 * async queue and the "bottom" keeps growing while the parser drains.
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
 * are written back to the store so the next session spawns at the right
 * size instead of 120×30-then-resize (ConPTY shreds early progress-bar
 * lines on that reflow).
 */
import { useCallback, useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { pipeline } from '@renderer/cpu';
import { CHANNELS, EVENTS } from '@shared/protocol';
import type { DocContent, SessionOutputPayload } from '@shared/types';
import { composeDocPasteBlock, getDocDragPath, isDocDrag } from '@renderer/lib/doc-drag';
import { matchKeybinding } from '@shared/terminal-keybindings';
import { attachImeCompositionEndCleaner } from '@shared/ime-textarea-workaround';
import { attachImeCompositionPositionLock } from '@shared/ime-composition-position-lock';
import { readClipboardText, writeClipboardText } from '@renderer/lib/clipboard';
import { getXtermTheme, isLightTheme, LIGHT_THEME_MIN_CONTRAST } from '@renderer/theme/xterm-themes';
import { getSettings, useSettings } from '@renderer/stores/settings-store';
import { setLastTerminalDims } from '@renderer/stores/session-store';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Chunked btoa — String.fromCharCode(...bytes) overflows the arg stack on
 *  large pastes, so never spread the whole buffer. */
function encodeStringToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const onWindows = navigator.platform.toLowerCase().includes('win');

/** xterm getSelection() yields LF; native Windows apps expect CRLF (CPB-C4). */
function selectionForClipboard(sel: string): string {
  return onWindows ? sel.replace(/\n/g, '\r\n') : sel;
}

const MIN_COLS = 20;
const MIN_ROWS = 5;
const RESIZE_DEBOUNCE_MS = 150;
const REPLAY_CHUNK_BYTES = 16 * 1024;
const LARGE_PASTE_BYTES = 1024 * 1024;
const REPLAY_FAILSAFE_MS = 5000;

export function TerminalView({ sessionId }: { sessionId: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const settings = useSettings();

  // SCROLL-1: hidden + inert until the replay has anchored bottom and the
  // renderer has painted the final state. RightPane keys this component by
  // sessionId, so every session switch starts hidden again.
  const [hostRevealed, setHostRevealed] = useState(false);
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
  const pasteText = useCallback(async (text: string) => {
    const term = termRef.current;
    if (!term) return;
    try {
      if (!text) return;

      // CPB-P4: >1MB pre-flight — a mis-copied log file can wedge ConPTY.
      if (new Blob([text]).size > LARGE_PASTE_BYTES) {
        const mb = (new Blob([text]).size / 1024 / 1024).toFixed(2);
        if (!window.confirm(`即将粘贴 ${mb} MB 内容到终端。\n过大的粘贴可能让 shell 长时间无响应。继续？`)) {
          return;
        }
      }

      // Embedded ESC can rewrite terminal state (ANSI injection from a
      // malicious page). Bracketed paste makes it literal where supported,
      // but the user decides (CPB-P7/P8).
      if (text.includes('\x1b')) {
        if (!window.confirm('剪贴板内容包含 ESC 控制字符（可能改终端状态/清屏/改标题）。\n常见于恶意网页内容。仍要粘贴？')) {
          return;
        }
      }

      // term.paste() normalizes line endings and applies bracketed-paste
      // wrapping iff the running app enabled mode 2004 — PSReadLine and the
      // agent CLIs do, so multi-line lands as editable literal text. When
      // the mode is off (bare cmd.exe), multi-line would execute line by
      // line — confirm first (Marina's no-bracketed-paste fallback).
      if (!term.modes.bracketedPasteMode) {
        const lines = text.split(/\r\n|\r|\n/);
        while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        if (lines.length > 1) {
          if (!window.confirm(`即将粘贴 ${lines.length} 行内容。\n当前程序未启用 bracketed paste，多行会被逐行立即执行。继续？`)) {
            return;
          }
        }
      }

      term.paste(text);
    } finally {
      // CPB-P1: focus back no matter what (confirm dialogs steal it).
      termRef.current?.focus();
    }
  }, []);

  const handlePaste = useCallback(async () => {
    const text = await readClipboardText();
    await pasteText(text);
  }, [pasteText]);

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
      const term = termRef.current;
      if (!term || paths.length === 0) return;
      const SHELL_METAS = /[;&`$|<>(){}\\!*?\n\r]/;
      const dangerous = paths.filter((p) => SHELL_METAS.test(p));
      if (dangerous.length > 0) {
        if (
          !window.confirm(
            `拖入的文件路径含 shell 元字符（; & \` $ | < > 等）。\n某些 shell 会把它们当成命令分隔符或子命令，可能意外执行。\n\n${dangerous.join('\n')}\n\n仍要粘贴？`,
          )
        ) {
          term.focus();
          return;
        }
      }
      // Windows paths can't contain ", so quoting only paths with whitespace
      // is sufficient.
      const quoted = paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ');
      try {
        await window.api.invoke(CHANNELS.SESSION_INPUT, {
          sessionId,
          data: encodeStringToBase64(quoted),
        });
      } catch (err) {
        console.warn('[TerminalView] file drop send-input failed', err);
      } finally {
        termRef.current?.focus();
      }
    },
    [sessionId],
  );

  /** Drop of a doc row: read the file fresh and paste header + snapshot. */
  const handleDocDrop = useCallback(
    async (docPath: string) => {
      try {
        const content = await window.api.invoke<{ path: string }, DocContent>(
          CHANNELS.DOC_READ,
          { path: docPath },
        );
        await pasteText(composeDocPasteBlock(content));
      } catch (err) {
        console.warn('[TerminalView] doc drop paste failed', err);
        termRef.current?.focus();
      }
    },
    [pasteText],
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
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
    if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = setTimeout(() => {
      wheelTimerRef.current = null;
      const settled = pendingFontSizeRef.current;
      pendingFontSizeRef.current = null;
      if (settled == null) return;
      void pipeline.dispatch('settings.update', {
        appearance: { terminalFontSize: settled },
      });
    }, 120);
  }, []);

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

    const s = getSettings();
    const themeId = s?.appearance.theme;
    const term = new Terminal({
      scrollback: 5000, // must match main's headless mirror
      fontFamily:
        s?.appearance.terminalFontFamily ??
        "'Cascadia Mono', 'JetBrains Mono', 'Consolas', monospace",
      fontSize: s?.appearance.terminalFontSize ?? 13,
      lineHeight: s?.appearance.terminalLineHeight ?? 1.2,
      theme: getXtermTheme(themeId),
      // Light themes turn on a WCAG-AA contrast floor so dim/256-color text
      // (Claude Code hints, git diff context) stays readable on a pale base;
      // dark themes keep 1 (no clamp) to preserve intentional muting (BETA-035).
      minimumContrastRatio: isLightTheme(themeId) ? LIGHT_THEME_MIN_CONTRAST : 1,
      // Match the app-wide 10px themed scrollbars (global.css). Side effect:
      // setting width enables the overview ruler — its always-painted 1px
      // outline is neutralized via theme.overviewRulerBorder = background.
      scrollbar: { width: 10 },
      allowProposedApi: true,
      ...(window.api.windowsBuild
        ? { windowsPty: { backend: 'conpty' as const, buildNumber: window.api.windowsBuild } }
        : {}),
    });
    termRef.current = term;

    let disposed = false;

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

    const fit = new FitAddon();
    term.loadAddon(fit);
    fitRef.current = fit;
    term.loadAddon(new WebLinksAddon());

    // SearchAddon (Ctrl+F). onDidChangeResults feeds the "x / N" hit counter;
    // registerDecoration (match highlight + overview-ruler markers) needs
    // allowProposedApi, already true above.
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
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

    term.open(host);

    // PER-1: WebGL after open() (needs the canvas); on GPU context loss
    // dispose the addon and let xterm fall back to the DOM renderer.
    // advanced.terminalRenderer 'dom' skips the addon entirely (WebGL-compat
    // escape hatch); 'auto'/'webgl' both try-with-fallback. Mount-time
    // decision — sessions remount on switch, so changes apply then.
    let webglAddon: WebglAddon | null = null;
    if ((s?.advanced.terminalRenderer ?? 'auto') !== 'dom') {
      try {
        webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          try {
            webglAddon?.dispose();
          } catch {
            /* ignore */
          }
          webglAddon = null;
        });
        term.loadAddon(webglAddon);
      } catch {
        webglAddon = null; // canvas/dom fallback, purely cosmetic
      }
    }

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
    let detachImeCleaner: (() => void) | null = null;
    let detachImeLock: (() => void) | null = null;
    if (helperTa) {
      try {
        detachImeCleaner = attachImeCompositionEndCleaner(helperTa);
      } catch (err) {
        console.warn('[TerminalView] IME-1 workaround attach failed', err);
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const core = (term as any)._core;
        const compHelper = core?._compositionHelper;
        const bufferService = core?._bufferService;
        if (
          compHelper &&
          typeof compHelper.updateCompositionElements === 'function' &&
          bufferService?.buffer &&
          typeof bufferService.buffer.x === 'number' &&
          typeof bufferService.buffer.y === 'number'
        ) {
          detachImeLock = attachImeCompositionPositionLock(helperTa, compHelper, bufferService);
        } else {
          console.warn('[TerminalView] IME-2 position lock skipped — _core shape changed?');
        }
      } catch (err) {
        console.warn('[TerminalView] IME-2 position lock attach failed', err);
      }
    }

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
      setLastTerminalDims({ cols, rows });
      void window.api.invoke(CHANNELS.SESSION_RESIZE, { sessionId, cols, rows });
    });

    const safeFit = (): void => {
      try {
        fit.fit();
      } catch {
        /* zero-size during layout shuffles */
      }
    };

    // 勘误 #4: trailing debounce — dragging the pane sash fires dozens of
    // RO callbacks per second, and every one used to hit ConPTY with a
    // reflow (progress bars get shredded into junk lines).
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (disposed) return;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        safeFit();
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);

    // RSZ-2: maximize/restore is an instant jump, not a drag — skip the
    // debounce (one frame for the chrome layout to settle).
    const unsubscribeMax = window.api.on<{ maximized: boolean }>(
      EVENTS.WINDOW_MAXIMIZED_CHANGED,
      () => {
        if (disposed) return;
        if (resizeTimer !== null) {
          clearTimeout(resizeTimer);
          resizeTimer = null;
        }
        requestAnimationFrame(() => {
          if (!disposed) safeFit();
        });
      },
    );

    // XTM-9: metrics measured against a fallback font are wrong until the
    // webfont (霞鹜文楷 etc.) is in; re-fit once it lands.
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!disposed) safeFit();
      });
    }

    let replayDone = false;
    let lastSeq = -1;
    const holdQueue: SessionOutputPayload[] = [];

    // 1) subscribe FIRST (hold until replay lands)
    const unsubscribe = window.api.on<SessionOutputPayload>(EVENTS.SESSION_OUTPUT, (payload) => {
      if (payload.sessionId !== sessionId) return;
      if (!replayDone) {
        holdQueue.push(payload);
        return;
      }
      if (payload.seq <= lastSeq) return; // already inside the replay
      lastSeq = payload.seq;
      term.write(b64ToBytes(payload.data));
    });

    // 2) input plumbing. XTM-7: flush a pending debounced fit before any
    // keystroke so the PTY never wraps the prompt at stale dims.
    const dataDisposable = term.onData((data) => {
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
        safeFit();
      }
      void window.api.invoke(CHANNELS.SESSION_INPUT, {
        sessionId,
        data: encodeStringToBase64(data),
      });
    });

    // 3) replay
    const finishReplay = (): void => {
      // SCROLL-1: write('', cb) is xterm's parser-drain fence — only inside
      // it is "bottom" the real final bottom. Reveal one RAF later so the
      // first visible frame is the final canvas.
      let revealed = false;
      const reveal = (): void => {
        if (disposed || revealed) return;
        revealed = true;
        term.scrollToBottom();
        requestAnimationFrame(() => {
          if (!disposed) setHostRevealed(true);
        });
      };
      const fallbackTimer = setTimeout(() => {
        if (disposed || revealed) return;
        console.warn('[TerminalView] replay fence timed out; revealing terminal fallback', {
          sessionId,
        });
        reveal();
      }, REPLAY_FAILSAFE_MS);
      term.write('', () => {
        clearTimeout(fallbackTimer);
        reveal();
      });
    };

    void (async () => {
      safeFit();
      // mount-resize: even a no-op opens main's resize-quiet window so the
      // TUI's "I got re-shown" repaint doesn't light the status dot.
      void window.api.invoke(CHANNELS.SESSION_RESIZE, {
        sessionId,
        cols: term.cols,
        rows: term.rows,
      });
      try {
        const scrollbackPromise = window.api.invoke<
          { sessionId: string },
          { data: string; lastSeq: number }
        >(CHANNELS.SESSION_SCROLLBACK, { sessionId });
        let scrollbackTimer: ReturnType<typeof setTimeout> | null = null;
        const replay = await Promise.race([
          scrollbackPromise,
          new Promise<{ data: string; lastSeq: number }>((_, reject) => {
            scrollbackTimer = setTimeout(
              () => reject(new Error(`SESSION_SCROLLBACK timed out after ${REPLAY_FAILSAFE_MS}ms`)),
              REPLAY_FAILSAFE_MS,
            );
          }),
        ]).finally(() => {
          if (scrollbackTimer !== null) clearTimeout(scrollbackTimer);
        });
        if (disposed) return;
        if (replay.data) {
          // FLK-1: chunked write + yields — a multi-MB scrollback written in
          // one call blocks the main thread for 100-300ms.
          const all = b64ToBytes(replay.data);
          for (let i = 0; i < all.length; i += REPLAY_CHUNK_BYTES) {
            if (disposed) return;
            term.write(all.subarray(i, i + REPLAY_CHUNK_BYTES));
            if (all.length > REPLAY_CHUNK_BYTES && i + REPLAY_CHUNK_BYTES < all.length) {
              await new Promise((r) => setTimeout(r, 0));
            }
          }
        }
        if (disposed) return;
        lastSeq = replay.lastSeq;
        replayDone = true;
        for (const payload of holdQueue) {
          if (payload.seq <= lastSeq) continue;
          lastSeq = payload.seq;
          term.write(b64ToBytes(payload.data));
        }
        holdQueue.length = 0;
        finishReplay();
      } catch (err) {
        console.warn('[TerminalView] scrollback replay failed, going live', err);
        if (disposed) return;
        for (const payload of holdQueue) {
          if (payload.seq > lastSeq) {
            lastSeq = payload.seq;
            term.write(b64ToBytes(payload.data));
          }
        }
        holdQueue.length = 0;
        replayDone = true;
        finishReplay(); // must still reveal, or the terminal stays invisible
      }
    })();

    return () => {
      disposed = true;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      if (selectionTimer !== null) clearTimeout(selectionTimer);
      unsubscribe();
      unsubscribeMax();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      selectionDisposable.dispose();
      observer.disconnect();
      detachImeCleaner?.();
      detachImeLock?.();
      helperTa?.removeEventListener('paste', pasteInterceptor, true);
      host.removeEventListener('paste', pasteInterceptor, true);
      searchResultsDisposable?.dispose();
      searchAddon.dispose();
      // PER-1: release the GL context before term.dispose or the handle leaks.
      try {
        webglAddon?.dispose();
      } catch {
        /* ignore */
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
    // Recreate only per session — theme/font changes apply via the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // SCROLL-1 round 2: inert while hidden — replay takes 100-500ms and keys
  // pressed in that window must not leak into other focusables. (React 18
  // has no `inert` prop; set the attribute directly.)
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (hostRevealed) host.removeAttribute('inert');
    else host.setAttribute('inert', '');
  }, [hostRevealed]);

  // Flush any pending Ctrl+wheel font-size write on unmount.
  useEffect(() => {
    return () => {
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
    };
  }, []);

  // Focus once revealed (inert blocked focus until now). Skip when the search
  // bar is open — the query input owns focus then.
  useEffect(() => {
    if (!hostRevealed) return;
    if (searchVisibleRef.current) return;
    requestAnimationFrame(() => {
      termRef.current?.focus();
    });
  }, [hostRevealed]);

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
    const term = termRef.current;
    if (!term || !settings) return;
    term.options.theme = getXtermTheme(settings.appearance.theme);
    term.options.minimumContrastRatio = isLightTheme(settings.appearance.theme)
      ? LIGHT_THEME_MIN_CONTRAST
      : 1;
    term.options.fontFamily = settings.appearance.terminalFontFamily;
    term.options.fontSize = settings.appearance.terminalFontSize;
    term.options.lineHeight = settings.appearance.terminalLineHeight;
    try {
      fitRef.current?.fit(); // metrics changed → re-measure (PTY hears via onResize)
    } catch {
      /* ignore */
    }
  }, [settings]);

  return (
    <div className="relative h-full w-full">
      <ContextMenu
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
        <ContextMenuTrigger asChild>
          <div
            ref={hostRef}
            className="h-full w-full px-1 pt-1"
            style={hostRevealed ? undefined : { visibility: 'hidden' }}
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
            // Electron 31 still exposes File.path; 32+ needs webUtils.getPathForFile.
            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) {
              e.preventDefault();
              const paths = files
                .map((f) => (f as File & { path?: string }).path)
                .filter((p): p is string => !!p && p.length > 0);
              if (paths.length > 0) void handleFileDrop(paths);
            }
          }}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={!ctxHasSelection} onClick={handleCopy}>
            复制
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void handlePaste()}>粘贴</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleClear}>清屏</ContextMenuItem>
          <ContextMenuItem onClick={handleOpenSearch}>搜索…</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {searchVisible && (
        <div
          role="search"
          aria-label="终端搜索"
          className="absolute right-4 top-2 z-50 flex items-center gap-1 rounded-md border bg-popover px-1.5 py-1 text-popover-foreground shadow-md"
        >
          <input
            ref={searchInputRef}
            type="text"
            className="h-6 w-56 rounded-sm border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
            placeholder="搜索 (Enter 下一个 / Shift+Enter 上一个 / Esc 关闭)"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                handleCloseSearch();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                performSearch(e.shiftKey ? 'previous' : 'next');
              }
            }}
          />
          <span className="min-w-[3rem] px-1 text-center font-mono text-[11px] text-muted-foreground">
            {searchText
              ? searchResults.matches > 0
                ? `${searchResults.current}/${searchResults.matches}`
                : '无匹配'
              : '—'}
          </span>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-sm border text-xs hover:bg-accent disabled:opacity-40"
            onClick={() => performSearch('previous')}
            title="上一个 (Shift+Enter)"
            aria-label="上一个匹配"
            disabled={!searchText || searchResults.matches === 0}
          >
            ↑
          </button>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-sm border text-xs hover:bg-accent disabled:opacity-40"
            onClick={() => performSearch('next')}
            title="下一个 (Enter)"
            aria-label="下一个匹配"
            disabled={!searchText || searchResults.matches === 0}
          >
            ↓
          </button>
          <button
            type="button"
            className={`flex h-6 w-6 items-center justify-center rounded-sm border text-xs hover:bg-accent ${
              searchCaseSensitive ? 'bg-accent text-accent-foreground' : ''
            }`}
            onClick={() => setSearchCaseSensitive((v) => !v)}
            title="区分大小写"
            aria-label="区分大小写"
            aria-pressed={searchCaseSensitive}
          >
            Aa
          </button>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-sm border text-xs hover:bg-destructive hover:text-destructive-foreground"
            onClick={handleCloseSearch}
            title="关闭 (Esc)"
            aria-label="关闭搜索"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
