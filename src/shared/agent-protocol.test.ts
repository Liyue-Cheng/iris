/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { agentHistoryDigest, IRIS_AGENT_PROTOCOL_VERSION, isAgentWorkerRequest } from './agent-protocol';

/** The tool-result validator is module-private; exercise it through the envelope. */
function isJtpCallRecordResultForTest(value: unknown): boolean {
  return isAgentWorkerRequest({
    version: IRIS_AGENT_PROTOCOL_VERSION,
    type: 'tool-result',
    correlation: { sessionId: 'session-1', operationId: 'operation-1' },
    ok: true,
    result: value,
  });
}

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
      isAgentWorkerRequest({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'initialize',
        correlation: { sessionId: 'session-1' },
        history: { revision: 1, anchor: { kind: 'workspace', path: '.iris' }, messages: [] },
        runtime: {
          cwd: process.cwd(),
          agentDir: process.cwd(),
          providerProfileRoot: process.cwd(),
          commandShell: { kind: 'powershell', executable: 'pwsh.exe', displayName: 'PowerShell 7' },
        },
      }),
    ).toBe(true);
    expect(
      isAgentWorkerRequest({ version: 1, type: 'shutdown', correlation: { sessionId: 'session-1' } }),
    ).toBe(false);
    expect(isAgentWorkerRequest({ version: IRIS_AGENT_PROTOCOL_VERSION, type: 'shutdown', correlation: {} })).toBe(false);
    expect(
      isAgentWorkerRequest({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'run',
        correlation: { sessionId: 'session-1', intentId: 'intent-1' },
        history: { revision: 1, anchor: { kind: 'workspace', path: '.iris' }, messages: [] },
        prompt: 'work',
        runtime: {
          model: { provider: 'openai', modelId: 'gpt-test' },
          providerProxy: { mode: 'proxy', url: 'http://127.0.0.1:7890/' },
        },
      }),
    ).toBe(true);
    expect(
      isAgentWorkerRequest({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'run',
        correlation: { sessionId: 'session-1', intentId: 'intent-1' },
        history: { revision: 1, anchor: { kind: 'workspace', path: '.iris' }, messages: [] },
        prompt: 'work',
        runtime: {
          model: { provider: 'openai', modelId: 'gpt-test' },
          providerProxy: { mode: 'proxy', url: 'socks5://127.0.0.1:1080' },
        },
      }),
    ).toBe(false);
    expect(
      isAgentWorkerRequest({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'initialize',
        correlation: { sessionId: 'session-1' },
        history: { revision: 1, anchor: { kind: 'workspace', path: '.iris' }, messages: [] },
        runtime: { cwd: process.cwd(), agentDir: process.cwd() },
      }),
    ).toBe(false);
    expect(
      isAgentWorkerRequest({
        version: IRIS_AGENT_PROTOCOL_VERSION,
        type: 'unknown',
        correlation: { sessionId: 'session-1' },
      }),
    ).toBe(false);
  });

  it('validates the images a run request carries', () => {
    const attachment = {
      id: 'c'.repeat(64),
      name: 'shot.png',
      mimeType: 'image/png' as const,
      bytes: 32,
      width: 8,
      height: 6,
    };
    const base = {
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'run' as const,
      correlation: { sessionId: 'session-1', intentId: 'intent-1' },
      history: { revision: 1, anchor: { kind: 'workspace' as const, path: '.iris' }, messages: [] },
      prompt: 'work',
      runtime: {
        model: { provider: 'openai', modelId: 'gpt-test' },
        providerProxy: { mode: 'direct' as const },
      },
    };
    expect(isAgentWorkerRequest({
      ...base,
      attachments: [{ type: 'image', attachment, dataBase64: 'AAAA' }],
    })).toBe(true);
    // Omitting them stays valid: a plain text request is unchanged.
    expect(isAgentWorkerRequest(base)).toBe(true);
    expect(isAgentWorkerRequest({
      ...base,
      attachments: [{ type: 'image', attachment, dataBase64: 42 }],
    })).toBe(false);
    expect(isAgentWorkerRequest({
      ...base,
      attachments: [{ type: 'image', dataBase64: 'AAAA' }],
    })).toBe(false);
    expect(isAgentWorkerRequest({ ...base, attachments: [{ type: 'text', text: 'hi' }] }))
      .toBe(false);
  });

  it('changes the history digest when message content changes', () => {
    const history = {
      revision: 1,
      anchor: { kind: 'workspace' as const, path: '.iris' },
      messages: [{
        id: 'message-1',
        intentId: 'intent-1',
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

  it('accepts an image content part and rejects a malformed attachment', () => {
    const attachment = {
      id: 'a'.repeat(64),
      name: 'shot.png',
      mimeType: 'image/png' as const,
      bytes: 32,
      width: 4,
      height: 4,
    };
    const history = {
      revision: 1,
      anchor: { kind: 'workspace' as const, path: '.iris' },
      messages: [{
        id: 'message-1',
        intentId: 'intent-1',
        turnId: 'turn-1',
        role: 'tool' as const,
        content: [{ type: 'image' as const, attachment, dataBase64: 'AAAA' }],
        attachments: [attachment],
        toolCallId: 'tool-1',
        tool: 'read' as const,
        createdAt: 1,
      }],
    };
    expect(isAgentWorkerRequest({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'run',
      correlation: { sessionId: 'session-1', intentId: 'intent-1' },
      history,
      prompt: 'work',
      runtime: {
        model: { provider: 'openai', modelId: 'gpt-test' },
        providerProxy: { mode: 'direct' },
      },
    })).toBe(true);

    // An id that is not a content hash would let a forged descriptor pick any
    // file inside the attachment directory, so the protocol refuses it here.
    const forged = {
      ...history,
      messages: [{
        ...history.messages[0]!,
        attachments: [{ ...attachment, id: '../../etc/passwd' }],
      }],
    };
    expect(isAgentWorkerRequest({
      version: IRIS_AGENT_PROTOCOL_VERSION,
      type: 'run',
      correlation: { sessionId: 'session-1', intentId: 'intent-1' },
      history: forged,
      prompt: 'work',
      runtime: {
        model: { provider: 'openai', modelId: 'gpt-test' },
        providerProxy: { mode: 'direct' },
      },
    })).toBe(false);

    // SVG is deliberately not a supported attachment MIME type.
    expect(isJtpCallRecordResultForTest({
      kind: 'image',
      mimeType: 'image/svg+xml',
      contentBase64: 'AAAA',
      bytes: 3,
    })).toBe(false);
    expect(isJtpCallRecordResultForTest({
      kind: 'image',
      mimeType: 'image/png',
      contentBase64: 'AAAA',
      bytes: 3,
      width: 4,
      height: 4,
    })).toBe(true);
  });

  it('keeps the history digest stable when only image bytes differ in encoding', () => {
    const attachment = {
      id: 'b'.repeat(64),
      name: 'shot.png',
      mimeType: 'image/png' as const,
      bytes: 32,
    };
    const history = {
      revision: 1,
      anchor: { kind: 'workspace' as const, path: '.iris' },
      messages: [{
        id: 'message-1',
        intentId: 'intent-1',
        turnId: 'turn-1',
        role: 'tool' as const,
        content: [{ type: 'image' as const, attachment, dataBase64: 'AAAA' }],
        toolCallId: 'tool-1',
        tool: 'read' as const,
        createdAt: 1,
      }],
    };
    // The digest decides runtime identity, and an attachment id is the sha256 of
    // its bytes, so re-encoding the same image must not look like a new history.
    expect(agentHistoryDigest({
      ...history,
      messages: [{ ...history.messages[0]!, content: [
        { type: 'image' as const, attachment, dataBase64: 'BBBB' },
      ] }],
    })).toBe(agentHistoryDigest(history));
  });
});

