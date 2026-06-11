/**
 * One mounted xterm per visible session (Marina's state-replay protocol):
 *
 *   mount → subscribe live output into a hold queue → fetch the serialized
 *   full-state replay {data, lastSeq} → write replay → flush queued chunks
 *   with seq > lastSeq → stream live.
 *
 * Subscribing BEFORE the replay fetch is what closes the gap: bytes arriving
 * during the fetch are queued, then seq-filtered — no loss, no double-write.
 * Switching sessions destroys this view and replays the next one; the main
 * process's headless mirror is the source of truth, so buffers survive any
 * number of remounts (alt-buffer TUIs included).
 */
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { CHANNELS, EVENTS } from '@shared/protocol';
import type { SessionOutputPayload } from '@shared/types';
import { getXtermTheme } from '@renderer/theme/xterm-themes';
import { getSettings, useSettings } from '@renderer/stores/settings-store';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function TerminalView({ sessionId }: { sessionId: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const settings = useSettings();

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
      theme: getXtermTheme(themeId),
      allowProposedApi: true,
      ...(window.api.windowsBuild
        ? { windowsPty: { backend: 'conpty' as const, buildNumber: window.api.windowsBuild } }
        : {}),
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL unavailable → canvas/dom renderer fallback, purely cosmetic
    }

    let disposed = false;
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

    // 2) input / resize plumbing
    const dataDisposable = term.onData((data) => {
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(data)));
      void window.api.invoke(CHANNELS.SESSION_INPUT, { sessionId, data: b64 });
    });
    const sendResize = (): void => {
      void window.api.invoke(CHANNELS.SESSION_RESIZE, {
        sessionId,
        cols: term.cols,
        rows: term.rows,
      });
    };
    const resizeDisposable = term.onResize(() => sendResize());
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* zero-size during layout shuffles */
      }
    });
    observer.observe(host);

    // 3) replay
    void (async () => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      // mount-resize: even a no-op opens main's resize-quiet window so the
      // TUI's "I got re-shown" repaint doesn't light the status dot.
      sendResize();
      const replay = await window.api.invoke<{ sessionId: string }, { data: string; lastSeq: number }>(
        CHANNELS.SESSION_SCROLLBACK,
        { sessionId },
      );
      if (disposed) return;
      if (replay.data) {
        term.write(b64ToBytes(replay.data));
      }
      lastSeq = replay.lastSeq;
      replayDone = true;
      for (const payload of holdQueue) {
        if (payload.seq <= lastSeq) continue;
        lastSeq = payload.seq;
        term.write(b64ToBytes(payload.data));
      }
      holdQueue.length = 0;
      term.focus();
    })();

    return () => {
      disposed = true;
      unsubscribe();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
    // Recreate only per session — theme/font changes apply via the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Live theme/font switching without remount (xterm supports runtime opts).
  useEffect(() => {
    const term = termRef.current;
    if (!term || !settings) return;
    term.options.theme = getXtermTheme(settings.appearance.theme);
    term.options.fontFamily = settings.appearance.terminalFontFamily;
    term.options.fontSize = settings.appearance.terminalFontSize;
  }, [settings]);

  return <div ref={hostRef} className="h-full w-full px-1 pt-1" />;
}
