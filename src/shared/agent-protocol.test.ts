import { describe, expect, it } from 'vitest';
import { agentHistoryDigest, IRIS_AGENT_PROTOCOL_VERSION, isAgentWorkerRequest } from './agent-protocol';

describe('Iris Agent Worker protocol', () => {
  it('accepts only the current version with a session correlation', () => {
    expect(
      isAgentWorkerRequest({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'shutdown',
        correlation: { sessionId: 'session-1' },
      }),
    ).toBe(true);
    expect(
      isAgentWorkerRequest({ version: 1, type: 'shutdown', correlation: { sessionId: 'session-1' } }),
    ).toBe(false);
    expect(isAgentWorkerRequest({ version: IRIS_AGENT_PROTOCOL_VERSION, type: 'shutdown', correlation: {} })).toBe(false);
    expect(
      isAgentWorkerRequest({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'initialize',
        correlation: { sessionId: 'session-1' },
        history: { revision: 1, anchor: { kind: 'workspace', path: '.iris' }, messages: [] },
        runtime: { cwd: process.cwd(), agentDir: process.cwd() },
      }),
    ).toBe(true);
    expect(
      isAgentWorkerRequest({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'unknown',
        correlation: { sessionId: 'session-1' },
      }),
    ).toBe(false);
  });

  it('changes the history digest when message content changes', () => {
    const history = {
      revision: 1,
      anchor: { kind: 'workspace' as const, path: '.iris' },
      messages: [{
        id: 'message-1',
        turnId: 'turn-1',
        role: 'user' as const,
        content: 'one',
        createdAt: 1,
      }],
    };
    expect(agentHistoryDigest(history)).not.toBe(agentHistoryDigest({
      ...history,
      messages: [{ ...history.messages[0]!, content: 'two' }],
    }));
  });
});
