import { describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import xtermHeadless from '@xterm/headless';
import type { SettingsManager } from './settings-manager';
import type { SessionOutputPayload, SessionReplaySnapshot } from '@shared/types';
import { applyXtermSnapshotState } from '@shared/terminal/xterm-snapshot-state';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
import { TerminalSessionManager } from './terminal-session-manager';

function fixture() {
  let output!: (data: string) => void;
  const exits = new Set<(event: { exitCode: number }) => void>();
  const pty = {
    pid: 4242, write: vi.fn(), resize() {}, pause() {}, resume() {},
    onData: (callback: typeof output) => { output = callback; return { dispose() {} }; },
    onExit: (callback: (event: { exitCode: number }) => void) => { exits.add(callback); return { dispose: () => exits.delete(callback) }; },
    kill: () => { for (const callback of [...exits]) callback({ exitCode: 0 }); },
  } as unknown as IPty;
  const manager = new TerminalSessionManager({ get: () => ({
    agents: [{ id: 'shell', label: 'Shell', command: '' }],
    appearance: { theme: 'rose-pine' }, advanced: { activeIdleThresholdSeconds: 2 },
  }) } as unknown as SettingsManager, { spawnFn: () => pty, processTreeKillFn: null, ptyExitWaitMs: 100 });
  const session = manager.createSession({ docPath: null, agentId: 'shell', projectRoot: process.cwd(), projectGeneration: 1, cols: 20, rows: 5 });
  const delivered: SessionOutputPayload[] = [];
  manager.on('sessionOutput', (payload) => delivered.push(payload));
  return { manager, session, pty, delivered, output: (data: string) => output(data) };
}

const write = (term: InstanceType<typeof xtermHeadless.Terminal>, data: string | Uint8Array) =>
  new Promise<void>((resolve) => term.write(data, resolve));

async function restore(term: InstanceType<typeof xtermHeadless.Terminal>, replay: SessionReplaySnapshot): Promise<void> {
  await write(term, Buffer.from(replay.data, 'base64'));
  applyXtermSnapshotState(term, replay.continuationState!);
  if (replay.parserTail) await write(term, replay.parserTail);
}

describe('project terminal checkpoints', () => {
  it('does not duplicate output arriving after the checkpoint fence', async () => {
    const f = fixture();
    const restored = new xtermHeadless.Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    try {
      f.manager.attachOutput(f.session.id, 'view');
      f.output('A');
      const pending = f.manager.prepareReplay(f.session.id, 20, 5);
      await Promise.resolve();
      f.output('B');
      const replay = await pending;
      expect(replay.lastSeq).toBe(0);
      await vi.waitFor(() => expect(f.delivered.some((item) => item.seq === 1)).toBe(true));
      await restore(restored, replay);
      for (const payload of f.delivered.filter((item) => item.seq > replay.lastSeq)) {
        await write(restored, Buffer.from(payload.data, 'base64'));
      }
      expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe('AB');
    } finally { restored.dispose(); await f.manager.shutdown(); }
  });

  it('carries a fragmented mouse-mode prefix across a detached snapshot', async () => {
    const f = fixture();
    const restored = new xtermHeadless.Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    const replies: string[] = [];
    restored.onData((data) => replies.push(data));
    try {
      f.output('\x1b[?1003hhello\x1b[?100');
      const replay = await f.manager.prepareReplay(f.session.id, 20, 5);
      expect(replay.parserTail).toBe('\x1b[?100');
      await restore(restored, replay);
      await write(restored, '6h!\x1b[?1006$p');
      expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe('hello!');
      expect(restored.modes.mouseTrackingMode).toBe('any');
      expect(replies).toEqual(['\x1b[?1006;1$y']);
    } finally { restored.dispose(); await f.manager.shutdown(); }
  });

  it('answers hidden and attached queries once regardless of replay or ACK', async () => {
    const f = fixture();
    try {
      f.output('hello\x1b[6n');
      await f.manager.prepareReplay(f.session.id, 20, 5);
      expect(f.pty.write).toHaveBeenCalledExactlyOnceWith('\x1b[1;6R');
      f.manager.attachOutput(f.session.id, 'view');
      f.output('\x1b[6n');
      await f.manager.prepareReplay(f.session.id, 20, 5);
      expect(f.pty.write).toHaveBeenCalledTimes(2);
      await f.manager.prepareReplay(f.session.id, 20, 5);
      expect(f.pty.write).toHaveBeenCalledTimes(2);
    } finally { await f.manager.shutdown(); }
  });
});
