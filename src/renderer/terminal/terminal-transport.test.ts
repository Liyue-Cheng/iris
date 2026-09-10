import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENTS, CHANNELS } from '@shared/protocol';
import { IrisAgentTerminalTransport } from './terminal-transport';

describe('IrisAgentTerminalTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps Agent cursor output and replay onto the shared terminal protocol', async () => {
    let outputListener: ((payload: unknown) => void) | undefined;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === CHANNELS.IRIS_AGENT_TERMINAL_REPLAY) {
        return { data: 'cmVwbGF5', seq: 12 };
      }
      if (channel === CHANNELS.IRIS_AGENT_TERMINAL_ATTACH) return true;
      return undefined;
    });
    vi.stubGlobal('window', {
      api: {
        windowsBuild: 26100,
        invoke,
        on: vi.fn((event: string, listener: (payload: unknown) => void) => {
          expect(event).toBe(EVENTS.IRIS_AGENT_TERMINAL_OUTPUT);
          outputListener = listener;
          return vi.fn();
        }),
      },
    });
    const scope = { root: 'C:/project', generation: 4 };
    const transport = new IrisAgentTerminalTransport('agent-1', 'terminal-1', scope);
    const output = vi.fn();
    transport.onOutput(output);

    outputListener?.({ sessionId: 'agent-1', terminalId: 'terminal-1', seq: 14, data: 'bGl2ZQ==' });
    outputListener?.({ sessionId: 'other', terminalId: 'terminal-1', seq: 15, data: 'aWdub3Jl' });
    expect(output).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith({
      scope,
      sessionId: 'agent-1',
      seq: 14,
      data: 'bGl2ZQ==',
    });
    await expect(transport.requestReplay(80, 24)).resolves.toEqual({
      data: 'cmVwbGF5',
      lastSeq: 12,
      cols: 80,
      rows: 24,
    });
  });

  it('attaches, acks and detaches one dialog against its own attachment id', async () => {
    const invoke = vi.fn(async (_channel: string, _payload?: unknown) => undefined);
    vi.stubGlobal('window', {
      api: { windowsBuild: 26100, invoke, on: vi.fn(() => vi.fn()) },
    });
    const scope = { root: 'C:/project', generation: 4 };
    const transport = new IrisAgentTerminalTransport('agent-1', 'terminal-1', scope);

    await transport.attach();
    await transport.acknowledge(7);
    await transport.detach();

    const calls = invoke.mock.calls.map(([channel, payload]) => [channel, payload] as const);
    expect(calls.map(([channel]) => channel)).toEqual([
      CHANNELS.IRIS_AGENT_TERMINAL_ATTACH,
      CHANNELS.IRIS_AGENT_TERMINAL_ACK,
      CHANNELS.IRIS_AGENT_TERMINAL_DETACH,
    ]);
    const attachmentIds = calls.map(([, payload]) =>
      (payload as { attachmentId: string } | undefined)?.attachmentId);
    expect(new Set(attachmentIds).size).toBe(1);
    for (const [, payload] of calls) {
      expect(payload).toMatchObject({
        sessionId: 'agent-1',
        terminalId: 'terminal-1',
        expectedScope: scope,
      });
    }
    expect(calls[1]![1]).toMatchObject({ seq: 7 });
  });
});
