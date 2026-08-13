import { describe, expect, it } from 'vitest';
import { IRIS_AGENT_PROTOCOL_VERSION, isAgentWorkerRequest } from './agent-protocol';

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
      isAgentWorkerRequest({ version: 2, type: 'shutdown', correlation: { sessionId: 'session-1' } }),
    ).toBe(false);
    expect(isAgentWorkerRequest({ version: 1, type: 'shutdown', correlation: {} })).toBe(false);
    expect(
      isAgentWorkerRequest({
        version: 1,
        type: 'initialize',
        correlation: { sessionId: 'session-1' },
      }),
    ).toBe(false);
    expect(
      isAgentWorkerRequest({
        version: 1,
        type: 'unknown',
        correlation: { sessionId: 'session-1' },
      }),
    ).toBe(false);
  });
});
