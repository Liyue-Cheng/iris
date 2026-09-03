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
        return { data: 'cmVwbGF5', cursor: 12 };
      }
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

    outputListener?.({ sessionId: 'agent-1', terminalId: 'terminal-1', cursor: 14, data: 'bGl2ZQ==' });
    outputListener?.({ sessionId: 'other', terminalId: 'terminal-1', cursor: 15, data: 'aWdub3Jl' });
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
});
