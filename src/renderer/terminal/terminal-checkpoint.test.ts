// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalMirror } from '../../main/terminal/terminal-mirror';
import { BrowserXtermAdapter } from './xterm-adapter';
import { TerminalReplayController } from './replay-controller';
import { TerminalSessionRuntime } from './terminal-runtime';
import { TerminalViewportController } from './viewport-controller';
import type { TerminalTransport } from './terminal-transport';
import type { SessionReplaySnapshot } from '@shared/types';
import { captureXtermSnapshotState } from '@shared/terminal/xterm-snapshot-state';

vi.hoisted(() => { HTMLCanvasElement.prototype.getContext = () => null; });
afterEach(() => vi.unstubAllGlobals());

describe('browser replay continuation', () => {
  it.each([
    ['mouse CSI', '\x1b[?1003hhello\x1b[?100', '6h!'],
    ['title OSC', 'hello\x1b]0;ti', 'tle\x07!'],
    ['DEC charset', '\x1b(0lq', 'qk'],
    ['saved cursor', '\x1b[4;7H\x1b7\x1b[2;2Hstatus', '\x1b8!'],
    ['restricted scrolling', '\x1b[2;5r\x1b[4;7Hstatus', '!'],
    ['UTF-16 decoder', 'hello\ud83d', '\ude00!'],
  ])('restores %s after host sync controls, before queued live output', async (_name, prefix, suffix) => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    const adapter = new BrowserXtermAdapter({ fontFamily: 'monospace', fontSize: 13, lineHeight: 1.2, themeId: undefined, renderer: 'dom', windowsBuild: null, openLink() {} });
    const term = adapter.terminal;
    const mirror = new TerminalMirror(term.cols, term.rows, 100);
    const runtime = new TerminalSessionRuntime('test', { root: 'C:/project', generation: 1 });
    runtime.transition({ type: 'ATTACH' });
    let sequence = 0;
    let afterSnapshot: (() => void) | undefined;
    const transport = {
      attach: async () => undefined,
      acknowledge: async () => undefined,
      requestReplay: async (): Promise<SessionReplaySnapshot> => {
        const snapshot = await mirror.snapshot(100, 1000);
        afterSnapshot?.();
        return { ...snapshot, data: Buffer.from(snapshot.data).toString('base64'), lastSeq: sequence, cols: term.cols, rows: term.rows };
      },
    } as unknown as TerminalTransport;
    const viewport = new TerminalViewportController({ fit() {} }, 150);
    const controller = new TerminalReplayController(runtime, transport, {
      get cols() { return term.cols; }, get rows() { return term.rows; },
      write: (data, done) => term.write(data, done),
      scrollToBottom: () => term.scrollToBottom(),
      beginSynchronizedReplay: () => adapter.beginSynchronizedReplay(),
      endSynchronizedReplay: (done) => adapter.endSynchronizedReplay(done),
      restoreState: (state) => adapter.restoreState(state),
    }, viewport, { chunkBytes: 16, timeoutMs: 1000, reveal() {}, warn: (message, error) => { throw new Error(`${message}: ${String(error)}`); } });
    try {
      await controller.start();
      controller.freezeHistory();
      mirror.write(prefix);
      sequence = 1;
      afterSnapshot = () => {
        mirror.write(suffix);
        // A real PTY supplies complete UTF-8. The split UTF-16 case instead
        // checks the snapshot tail transport, then feeds the low surrogate.
        if (_name !== 'UTF-16 decoder') controller.onOutput({ scope: runtime.scope, sessionId: 'test', data: Buffer.from(suffix).toString('base64'), seq: 2 });
      };
      await controller.resumeFromHistory();
      if (_name === 'UTF-16 decoder') term.write(suffix);
      await new Promise<void>((done) => term.write(new Uint8Array(0), done));
      const expected = await mirror.snapshot(100, 1000);
      expect(captureXtermSnapshotState(term)).toEqual(expected.continuationState);
      const screen = Array.from({ length: term.rows }, (_, row) => term.buffer.active.getLine(term.buffer.active.baseY + row)?.translateToString(true) ?? '').join('\n').replace(/\n+$/, '');
      expect(screen).toBe(mirror.plainText(100));
      expect(runtime.state.phase).toBe('live');
    } finally { runtime.dispose(); viewport.dispose(); mirror.dispose(); adapter.dispose(); }
  });
});
