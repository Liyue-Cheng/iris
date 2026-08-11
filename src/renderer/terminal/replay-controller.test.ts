import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionOutputPayload, SessionReplaySnapshot } from '@shared/types';
import { TerminalReplayController, type ReplayTerminalPort } from './replay-controller';
import { TerminalSessionRuntime } from './terminal-runtime';
import type { TerminalTransport } from './terminal-transport';
import { TerminalViewportController } from './viewport-controller';

afterEach(() => {
  vi.unstubAllGlobals();
});

function output(seq: number, text: string): SessionOutputPayload {
  return {
    scope: { root: 'C:\\work', generation: 1 },
    sessionId: 'session-1',
    seq,
    data: btoa(text),
  };
}

function fixture(requestReplay: () => Promise<SessionReplaySnapshot>) {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  const runtime = new TerminalSessionRuntime('session-1', { root: 'C:\\work', generation: 1 });
  runtime.transition({ type: 'ATTACH' });
  const writes: string[] = [];
  const replayEvents: string[] = [];
  const terminal: ReplayTerminalPort = {
    cols: 80,
    rows: 24,
    write: (data, callback) => {
      if (data.byteLength > 0) writes.push(new TextDecoder().decode(data));
      callback?.();
    },
    scrollToBottom: vi.fn(),
    beginSynchronizedReplay: vi.fn(() => replayEvents.push('begin-sync')),
    endSynchronizedReplay: vi.fn((callback) => {
      replayEvents.push('end-sync');
      callback?.();
    }),
  };
  const transport: TerminalTransport = {
    windowsBuild: null,
    onOutput: () => () => undefined,
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    acknowledge: vi.fn(async () => undefined),
    requestReplay,
    sendInput: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    readDocument: vi.fn(async () => ({
      path: 'x',
      raw: '',
      body: '',
      frontmatter: null,
      frontmatterBroken: false,
    })),
    onWindowMaximized: () => () => undefined,
  };
  const viewport = new TerminalViewportController({ fit: vi.fn() }, 150);
  const reveal = vi.fn();
  const controller = new TerminalReplayController(runtime, transport, terminal, viewport, {
    chunkBytes: 16,
    timeoutMs: 100,
    reveal,
    warn: vi.fn(),
  });
  return { runtime, controller, writes, replayEvents, reveal, transport, terminal };
}

describe('TerminalReplayController', () => {
  it('filters snapshot overlap and releases queued output in causal order', async () => {
    const { controller, writes, reveal } = fixture(async () => ({
      data: btoa('snapshot'),
      lastSeq: 4,
      cols: 80,
      rows: 24,
    }));
    controller.onOutput(output(4, 'duplicate'));
    controller.onOutput(output(5, 'live'));
    await controller.start();
    expect(writes).toEqual(['snapshot', 'live']);
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('ignores a replay result that arrives after disposal', async () => {
    let resolveReplay: (snapshot: SessionReplaySnapshot) => void = () => undefined;
    const replay = new Promise<SessionReplaySnapshot>((resolve) => {
      resolveReplay = resolve;
    });
    const { runtime, controller, writes } = fixture(() => replay);
    const operation = controller.start();
    runtime.dispose();
    resolveReplay({ data: btoa('late'), lastSeq: 1, cols: 80, rows: 24 });
    await operation;
    expect(writes).toEqual([]);
  });

  it('drops unbounded live animation while history is frozen and resyncs from a snapshot', async () => {
    const snapshots = [
      { data: btoa('initial'), lastSeq: 1, cols: 80, rows: 24 },
      { data: btoa('resynced'), lastSeq: 20, cols: 80, rows: 24 },
    ];
    const { runtime, controller, writes, replayEvents, transport, terminal } = fixture(
      async () => snapshots.shift()!,
    );
    await controller.start();
    controller.freezeHistory();
    controller.onOutput(output(2, 'dropped-animation'));
    expect(runtime.state.phase).toBe('history-frozen');
    expect(transport.acknowledge).toHaveBeenCalledWith(2);
    await controller.resumeFromHistory();
    expect(runtime.state.phase).toBe('live');
    expect(writes).toEqual(['initial', 'resynced']);
    expect(replayEvents).toEqual(['begin-sync', 'end-sync']);
    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(2);
  });
});
