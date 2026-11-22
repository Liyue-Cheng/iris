import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionOutputPayload, SessionReplaySnapshot } from '@shared/types';
import { TerminalReplayController, type ReplayTerminalPort } from './replay-controller';
import { TerminalSessionRuntime } from './terminal-runtime';
import type { TerminalTransport } from './terminal-transport';
import { TerminalViewportController } from './viewport-controller';
import xtermHeadless from '@xterm/headless';

afterEach(() => {
  vi.useRealTimers();
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
      if (typeof data === 'string') writes.push(data);
      else if (data.byteLength > 0) writes.push(new TextDecoder().decode(data));
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
    dispose: vi.fn(),
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
  const recovery = vi.fn();
  const controller = new TerminalReplayController(runtime, transport, terminal, viewport, {
    chunkBytes: 16,
    timeoutMs: 100,
    reveal,
    recovery,
    warn: vi.fn(),
  });
  return { runtime, recovery, controller, writes, replayEvents, reveal, transport, terminal };
}

describe('TerminalReplayController', () => {
  it('bounds recovery attempts, blocks blind input and manually recovers the original attachment', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(new Error('snapshot unavailable'));
    const { controller, runtime, recovery, transport } = fixture(request);
    try {
      const beforeFailure = runtime.captureInput();
      await controller.start();
      expect(runtime.acceptsInput()).toBe(false);
      await vi.advanceTimersByTimeAsync(10000);
      expect(request).toHaveBeenCalledTimes(3);
      expect(recovery).toHaveBeenLastCalledWith({ exhausted: true, reason: 'snapshot unavailable' });
      request.mockResolvedValue({ cols: 80, rows: 24, lastSeq: 10, data: btoa('restored') });
      await controller.retryRecovery();
      expect(runtime.acceptsInput()).toBe(true);
      expect(runtime.acceptsInput(beforeFailure)).toBe(false);
      expect(recovery).toHaveBeenLastCalledWith(null);
      expect(transport.sendInput).not.toHaveBeenCalled();
    } finally { runtime.dispose(); }
  });

  it.each(['rejected', 'unanswered'])('retries a %s cumulative ACK when no more output arrives', async kind => {
    vi.useFakeTimers();
    const { controller, runtime, transport } = fixture(async () => ({ cols: 80, rows: 24, data: '', lastSeq: -1 }));
    try {
      await controller.start();
      if (kind === 'rejected') vi.mocked(transport.acknowledge).mockRejectedValueOnce(new Error('lost'));
      else vi.mocked(transport.acknowledge).mockReturnValueOnce(new Promise(() => {}));
      controller.onOutput(output(4, 'burst'));
      await vi.advanceTimersByTimeAsync(500);
      expect(transport.acknowledge).toHaveBeenCalledTimes(2);
      expect(transport.acknowledge).toHaveBeenLastCalledWith(4);
      expect(runtime.state.phase).toBe('live');
    } finally { runtime.dispose(); }
  });

  it('does not release blind input when ACKs still fail after a fresh snapshot', async () => {
    vi.useFakeTimers();
    const { controller, runtime, recovery, transport } = fixture(async () => ({
      cols: 80, rows: 24, data: btoa('screen'), lastSeq: 3,
    }));
    vi.mocked(transport.acknowledge).mockRejectedValue(new Error('no ACK'));
    try {
      await controller.start();
      await vi.advanceTimersByTimeAsync(10000);
      expect(recovery).toHaveBeenLastCalledWith({ exhausted: true, reason: 'no ACK' });
      expect(runtime.acceptsInput()).toBe(false);
      vi.mocked(transport.acknowledge).mockResolvedValue(undefined);
      await controller.retryRecovery();
      expect(runtime.acceptsInput()).toBe(true);
    } finally { runtime.dispose(); }
  });

  it('releases a late attachment owned by a disposed view', async () => {
    const { controller, runtime, transport } = fixture(async () => ({ cols: 80, rows: 24, data: '', lastSeq: -1 }));
    let attached!: () => void;
    vi.mocked(transport.attach).mockReturnValueOnce(new Promise(resolve => { attached = resolve; }));
    const start = controller.start();
    runtime.dispose();
    await start;
    attached();
    await vi.waitFor(() => expect(transport.detach).toHaveBeenCalledOnce());
  });

  it('holds unsafe output after a real parser timeout and replaces the screen on retry', async () => {
    const target = new xtermHeadless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    let releaseParser: (() => void) | undefined;
    const delayedHandler = () => new Promise<boolean>((resolve) => {
      releaseParser = () => resolve(true);
    });
    // xterm's parser supports async handlers, but headless's public types omit them.
    target.parser.registerOscHandler(777, delayedHandler as unknown as (data: string) => boolean);
    const snapshots = [
      { data: btoa('A\x1b]777;stall\x07'), lastSeq: 4, cols: 80, rows: 24, parserTail: 'stale-tail' },
      { data: btoa('fresh'), lastSeq: 6, cols: 80, rows: 24 },
    ];
    const { controller, runtime, terminal, transport } = fixture(async () => snapshots.shift()!);
    terminal.write = (data, callback) => target.write(data, callback);
    terminal.beginSynchronizedReplay = () => target.write('\x18\x1b[?2026h\x1b[2J\x1b[H');
    terminal.endSynchronizedReplay = (callback) => target.write('\x1b[?2026l', callback);
    terminal.scrollToBottom = () => target.scrollToBottom();
    try {
      controller.onOutput(output(4, 'duplicate'));
      controller.onOutput(output(5, 'untrusted'));
      await controller.start();
      expect(releaseParser).toBeTypeOf('function');
      expect(runtime.state.phase).toBe('degraded');
      expect(transport.acknowledge).toHaveBeenCalledWith(5);
      controller.onOutput(output(6, 'discarded-while-degraded'));
      expect(transport.acknowledge).toHaveBeenCalledWith(6);

      // Old queued parse callbacks can still run. They must neither install
      // stale parser continuation nor release any abandoned live payloads.
      releaseParser!();
      await new Promise<void>((done) => target.write(new Uint8Array(0), done));
      expect(target.buffer.active.getLine(0)?.translateToString(true)).toBe('A');
      await controller.resumeFromHistory();
      controller.onOutput(output(7, '!'));
      await new Promise<void>((done) => target.write(new Uint8Array(0), done));
      expect(runtime.state.phase).toBe('live');
      expect(target.buffer.active.getLine(0)?.translateToString(true)).toBe('fresh!');
    } finally {
      releaseParser?.();
      runtime.dispose();
      target.dispose();
    }
  });

  it('settles a pending replay on disposal and observes a later transport rejection', async () => {
    let rejectReplay!: (error: Error) => void;
    const pending = new Promise<SessionReplaySnapshot>((_resolve, reject) => { rejectReplay = reject; });
    const requestReplay = vi.fn(() => pending);
    const { controller, runtime, writes, reveal } = fixture(requestReplay);
    const start = controller.start();
    await vi.waitFor(() => expect(requestReplay).toHaveBeenCalledOnce());
    runtime.dispose();
    await start;
    rejectReplay(new Error('late IPC error'));
    await Promise.resolve();
    expect(writes).toEqual([]);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('allows a fresh attach and replay after the first attachment failed', async () => {
    const { controller, runtime, transport, writes } = fixture(async () => ({
      data: btoa('recovered'), lastSeq: 4, cols: 80, rows: 24,
    }));
    vi.mocked(transport.attach).mockRejectedValueOnce(new Error('attachment failed'));
    await controller.start();
    controller.onOutput(output(3, 'untrusted'));
    expect(runtime.state.phase).toBe('degraded');
    expect(writes).toEqual([]);
    await controller.resumeFromHistory();
    expect(transport.attach).toHaveBeenCalledTimes(2);
    expect(runtime.state.phase).toBe('live');
    expect(writes).toEqual(['recovered']);
    runtime.dispose();
  });

  it('keeps output frozen if continuation restoration throws, even after the screen was written', async () => {
    const { controller, runtime, terminal, transport, writes } = fixture(async () => ({
      data: btoa('snapshot'), lastSeq: 4, cols: 80, rows: 24,
      continuationState: {} as NonNullable<SessionReplaySnapshot['continuationState']>,
    }));
    terminal.restoreState = () => { throw new Error('incompatible continuation'); };
    controller.onOutput(output(4, 'duplicate'));
    controller.onOutput(output(5, 'unsafe-live'));
    await controller.start();
    controller.onOutput(output(6, 'still-unsafe'));
    expect(runtime.state.phase).toBe('degraded');
    expect(writes).toEqual(['snapshot']);
    expect(transport.acknowledge).toHaveBeenCalledWith(5);
    expect(transport.acknowledge).toHaveBeenCalledWith(6);
    runtime.dispose();
  });

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
