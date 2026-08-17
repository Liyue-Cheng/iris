import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { IRIS_AGENT_PROMPT } from './prompt';
import { applyIrisAgentMessageRewind } from './session-manager';
import type { IrisAgentSessionInfo } from '@shared/types';
import {
  createIrisPiResourceLoader,
  createIrisPiToolDefinitions,
  instrumentProviderPayloads,
  normalizeIrisProviderContext,
  restoreIrisPiHistory,
} from './pi-adapter';

describe('Iris Pi adapter', () => {
  it('loads only the built-in Iris prompt and no discovered Pi resources', async () => {
    const root = process.cwd();
    const loader = await createIrisPiResourceLoader(root, join(root, '.not-used-pi-agent'));
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getSystemPrompt()).toBe(IRIS_AGENT_PROMPT);
  });

  it('exposes only wrapped public Pi tool definitions and delegates operations', async () => {
    const root = process.cwd();
    const operations = {
      read: { access: vi.fn(async () => {}), readFile: vi.fn(async () => Buffer.from('hello')) },
      edit: {
        access: vi.fn(async () => {}),
        readFile: vi.fn(async () => Buffer.from('before')),
        writeFile: vi.fn(async () => {}),
      },
      write: { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) },
      terminal: {
        exec: vi.fn(async (_command, _cwd, options) => {
          options.onData(Buffer.from('terminal output'));
          return { exitCode: 0 };
        }),
      },
    };
    const tools = createIrisPiToolDefinitions(root, operations);
    expect(tools.map((tool) => tool.name)).toEqual(['read', 'edit', 'write', 'terminal']);
    const read = tools[0]!;
    const result = await read.execute(
      'call-1',
      { path: 'README.md' },
      undefined,
      undefined,
      {} as never,
    );
    expect(operations.read.readFile).toHaveBeenCalledWith(join(root, 'README.md'));
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(tools[3]!.promptGuidelines).toEqual([]);
  });

  it('injects persisted provider messages and tool results into Pi context', () => {
    const manager = SessionManager.inMemory(process.cwd());
    restoreIrisPiHistory(manager, {
      revision: 9,
      anchor: { kind: 'workspace', path: '.iris' },
      messages: [
        { id: 'u1', turnId: 'turn-1', role: 'user', content: 'novel', createdAt: 1 },
        {
          id: 'a1',
          turnId: 'turn-1',
          role: 'assistant',
          content: 'partial chapter',
          createdAt: 2,
          providerMessage: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'partial chapter' },
              { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'chapter.md' } },
            ],
            api: 'openai-responses',
            provider: 'openai',
            model: 'gpt-test',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'toolUse',
            timestamp: 2,
          },
        },
        {
          id: 't1',
          turnId: 'turn-1',
          role: 'tool',
          content: 'tool output',
          createdAt: 3,
          providerMessage: {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'tool output' }],
            isError: false,
            timestamp: 3,
          },
        },
      ],
    });

    const messages = manager.buildSessionContext().messages;
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(messages[0]).toMatchObject({ content: 'novel' });
    expect(messages[1]).toMatchObject({
      content: [
        { type: 'text', text: 'partial chapter' },
        { type: 'toolCall', id: 'call-1', name: 'read' },
      ],
    });
    expect(messages[2]).toMatchObject({ toolCallId: 'call-1' });
  });

  it('keeps stopped text and drops unrelated orphaned results at the real provider boundary', async () => {
    const payload = await captureDeepSeekProviderPayload({
      messages: [
        { role: 'user', content: '生成一个5000字的小说', timestamp: 1 },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'unfinished private reasoning', thinkingSignature: 'secret' },
            { type: 'text', text: '# 守钟人\n\n钟楼在城西已经站了一百二十年。', textSignature: 'provider-metadata' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'chapter.md' } },
          ],
          api: 'openai-responses',
          provider: 'previous-provider',
          model: 'previous-model',
          usage: zeroUsage(),
          stopReason: 'aborted',
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-from-lost-assistant-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'first orphaned result' }],
          isError: false,
          timestamp: 3,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-from-lost-assistant-2',
          toolName: 'terminal',
          content: [{ type: 'text', text: 'second orphaned result' }],
          isError: false,
          timestamp: 4,
        },
        { role: 'user', content: '刚刚网断了，你现在继续编写', timestamp: 5 },
      ],
    });

    expect(payload).toMatchObject({
      messages: [
        { role: 'user', content: '生成一个5000字的小说' },
        {
          role: 'assistant',
          content: '# 守钟人\n\n钟楼在城西已经站了一百二十年。',
        },
        { role: 'user', content: '刚刚网断了，你现在继续编写' },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('orphaned result');
  });

  it('keeps complete multi-tool exchanges while dropping duplicate and orphaned results', async () => {
    const toolAssistant = {
      role: 'assistant' as const,
      content: [
        { type: 'toolCall' as const, id: 'call-b', name: 'read', arguments: { path: 'b.md' } },
        { type: 'toolCall' as const, id: 'call-c', name: 'read', arguments: { path: 'c.md' } },
      ],
      api: 'openai-responses' as const,
      provider: 'provider',
      model: 'model',
      usage: zeroUsage(),
      stopReason: 'toolUse' as const,
      timestamp: 2,
    };
    const resultB = {
      role: 'toolResult' as const,
      toolCallId: 'call-b',
      toolName: 'read',
      content: [{ type: 'text' as const, text: 'result b' }],
      isError: false,
      timestamp: 3,
    };
    const duplicateB = { ...resultB, content: [{ type: 'text' as const, text: 'duplicate b' }] };
    const resultC = { ...resultB, toolCallId: 'call-c', content: [{ type: 'text' as const, text: 'result c' }] };
    const orphan = { ...resultB, toolCallId: 'call-orphan', content: [{ type: 'text' as const, text: 'orphan' }] };

    const context = {
      messages: [
        { role: 'user', content: 'inspect both files', timestamp: 1 },
        toolAssistant,
        resultB,
        duplicateB,
        resultC,
        orphan,
        { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'openai-responses', provider: 'provider', model: 'model', usage: zeroUsage(), stopReason: 'stop', timestamp: 4 },
      ],
    } satisfies Parameters<typeof normalizeIrisProviderContext>[0];
    const normalized = normalizeIrisProviderContext(context);

    expect(normalized.messages).toEqual([
      { role: 'user', content: 'inspect both files', timestamp: 1 },
      toolAssistant,
      resultB,
      resultC,
      { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'openai-responses', provider: 'provider', model: 'model', usage: zeroUsage(), stopReason: 'stop', timestamp: 4 },
    ]);

    const payload = await captureDeepSeekProviderPayload(context) as {
      messages: Array<{ role: string }>;
    };
    expect(payload.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(JSON.stringify(payload)).toContain('call-b');
    expect(JSON.stringify(payload)).toContain('call-c');
    expect(JSON.stringify(payload)).not.toContain('duplicate b');
    expect(JSON.stringify(payload)).not.toContain('call-orphan');
  });

  it('projects an incomplete tool-call assistant to safe text and drops its result run', () => {
    const normalized = normalizeIrisProviderContext({
      messages: [
        { role: 'user', content: 'before', timestamp: 1 },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'visible preface' },
            { type: 'toolCall', id: 'call-b', name: 'read', arguments: { path: 'b.md' } },
            { type: 'toolCall', id: 'call-c', name: 'read', arguments: { path: 'c.md' } },
          ],
          api: 'openai-responses',
          provider: 'provider',
          model: 'model',
          usage: zeroUsage(),
          stopReason: 'toolUse',
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-b',
          toolName: 'read',
          content: [{ type: 'text', text: 'only one result' }],
          isError: false,
          timestamp: 3,
        },
        { role: 'user', content: 'after', timestamp: 4 },
      ],
    });

    expect(normalized.messages).toMatchObject([
      { role: 'user', content: 'before' },
      { role: 'assistant', content: [{ type: 'text', text: 'visible preface' }], stopReason: 'stop' },
      { role: 'user', content: 'after' },
    ]);
  });

  it('keeps a persisted stopped partial after Pi session restoration and provider transformation', async () => {
    const manager = SessionManager.inMemory(process.cwd());
    restoreIrisPiHistory(manager, {
      revision: 2,
      anchor: { kind: 'workspace', path: '.iris' },
      messages: [
        { id: 'u1', turnId: 'turn-1', role: 'user', content: 'write a novel', createdAt: 1 },
        {
          id: 'a1',
          turnId: 'turn-1',
          role: 'assistant',
          content: 'partial chapter',
          createdAt: 2,
          providerMessage: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'unfinished reasoning' },
              { type: 'text', text: 'partial chapter' },
            ],
            api: 'openai-completions',
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
            usage: zeroUsage(),
            stopReason: 'aborted',
            timestamp: 2,
          },
        },
      ],
    });
    const normalized = normalizeIrisProviderContext(manager.buildSessionContext() as never);
    const payload = await captureDeepSeekProviderPayload(normalized);

    expect(payload).toMatchObject({
      messages: [
        { role: 'user', content: 'write a novel' },
        { role: 'assistant', content: 'partial chapter' },
      ],
    });
  });

  it('keeps a rewound suffix out of the real provider transformation', async () => {
    const session: IrisAgentSessionInfo = {
      id: 'session-1',
      kind: 'iris-agent',
      anchor: { kind: 'workspace', path: '.iris' },
      projectRoot: process.cwd(),
      projectGeneration: 1,
      displayName: 'Iris Agent',
      state: 'idle',
      createdAt: 1,
      updatedAt: 4,
      revision: 4,
      workerEpoch: 0,
      activeTurnId: null,
      messages: [
        { id: 'u1', turnId: 'turn-1', role: 'user', content: 'kept question', createdAt: 1 },
        { id: 'a1', turnId: 'turn-1', role: 'assistant', content: 'kept answer', createdAt: 2 },
        { id: 'u2', turnId: 'turn-2', role: 'user', content: 'removed question', createdAt: 3 },
        {
          id: 'a2',
          turnId: 'turn-2',
          role: 'assistant',
          content: 'removed answer',
          createdAt: 4,
          providerMessage: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'removed answer' },
              { type: 'toolCall', id: 'removed-call', name: 'read', arguments: { path: 'removed.md' } },
            ],
            api: 'openai-responses',
            provider: 'previous-provider',
            model: 'previous-model',
            usage: zeroUsage(),
            stopReason: 'aborted',
            timestamp: 4,
          },
        },
        {
          id: 't2',
          turnId: 'turn-2',
          role: 'tool',
          content: 'removed tool result',
          createdAt: 5,
          providerMessage: {
            role: 'toolResult',
            toolCallId: 'removed-call',
            toolName: 'read',
            content: [{ type: 'text', text: 'removed tool result' }],
            isError: false,
            timestamp: 5,
          },
        },
      ],
      turns: [
        {
          id: 'turn-1',
          userMessageId: 'u1',
          assistantMessageId: 'a1',
          requestId: 'request-1',
          status: 'completed',
          createdAt: 1,
          completedAt: 2,
        },
        {
          id: 'turn-2',
          userMessageId: 'u2',
          assistantMessageId: 'a2',
          requestId: 'request-2',
          status: 'completed',
          createdAt: 3,
          completedAt: 4,
        },
      ],
      toolEvents: [],
      fileEffects: [],
      requestFacts: [],
      selfHostingEligible: false,
    };
    const rewound = applyIrisAgentMessageRewind(session);
    const manager = SessionManager.inMemory(process.cwd());
    restoreIrisPiHistory(manager, {
      revision: 5,
      anchor: rewound.anchor,
      messages: rewound.messages,
    });
    const restored = manager.buildSessionContext();
    const payload = await captureDeepSeekProviderPayload(normalizeIrisProviderContext({
      ...restored,
      messages: [
        ...restored.messages,
        { role: 'user', content: 'request after rewind', timestamp: 5 },
      ],
    } as never));

    expect(payload).toMatchObject({
      messages: [
        { role: 'user', content: 'kept question' },
        { role: 'assistant', content: 'kept answer' },
        { role: 'user', content: 'request after rewind' },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('removed question');
    expect(JSON.stringify(payload)).not.toContain('removed answer');
    expect(JSON.stringify(payload)).not.toContain('removed tool result');
  });

  it('drops empty stopped responses and their orphaned tool results', () => {
    const context = normalizeIrisProviderContext({
      messages: [
        { role: 'user', content: 'before', timestamp: 1 },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'partial reasoning' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'file.md' } },
          ],
          api: 'openai-responses',
          provider: 'provider',
          model: 'model',
          usage: zeroUsage(),
          stopReason: 'aborted',
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'result' }],
          isError: false,
          timestamp: 3,
        },
        { role: 'user', content: 'after', timestamp: 4 },
      ],
    });

    expect(context.messages).toEqual([
      { role: 'user', content: 'before', timestamp: 1 },
      { role: 'user', content: 'after', timestamp: 4 },
    ]);
  });

  it('normalizes legacy assistant text restored without a provider message', () => {
    const manager = SessionManager.inMemory(process.cwd());
    restoreIrisPiHistory(manager, {
      revision: 1,
      anchor: { kind: 'workspace', path: '.iris' },
      messages: [
        { id: 'u1', turnId: 'turn-1', role: 'user', content: 'question', createdAt: 1 },
        { id: 'a1', turnId: 'turn-1', role: 'assistant', content: 'legacy answer', createdAt: 2 },
      ],
    });

    const normalized = normalizeIrisProviderContext(manager.buildSessionContext() as never);
    expect(normalized.messages).toMatchObject([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: [{ type: 'text', text: 'legacy answer' }], stopReason: 'stop' },
    ]);
  });

  it('captures the payload returned by the existing onPayload hook', async () => {
    let payloadPromise: Promise<unknown> | undefined;
    const originalStream = vi.fn((_model, _context, options) => {
      payloadPromise = Promise.resolve(options.onPayload?.(
        { input: [{ role: 'user', content: 'before' }] },
        { provider: 'openai', id: 'gpt-test', api: 'openai-responses' },
      ));
      return { marker: 'stream' };
    });
    const runtime = { streamSimple: originalStream };
    const captured: unknown[] = [];
    instrumentProviderPayloads(runtime as never, (payload) => {
      captured.push(payload);
    });

    const result = runtime.streamSimple({} as never, { messages: [] } as never, {
      onPayload: (payload: unknown) => ({ ...(payload as object), transformed: true }),
    } as never);
    await payloadPromise;

    expect(result).toEqual({ marker: 'stream' });
    expect(captured).toEqual([{
      input: [{ role: 'user', content: 'before' }],
      transformed: true,
    }]);
  });
});

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

async function captureDeepSeekProviderPayload(
  context: Parameters<typeof normalizeIrisProviderContext>[0],
): Promise<unknown> {
  const agentDir = await mkdtemp(join(tmpdir(), 'iris-pi-provider-'));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    await runtime.setRuntimeApiKey('deepseek', 'test-key');
    const model = runtime.getModel('deepseek', 'deepseek-v4-pro');
    if (!model) throw new Error('The pinned Pi model catalog is missing deepseek-v4-pro');
    let captured: unknown;
    instrumentProviderPayloads(runtime, (payload) => {
      captured = payload;
    });
    const abortController = new AbortController();
    const stream = runtime.streamSimple(model, context, {
      signal: abortController.signal,
      onPayload: (payload) => {
        abortController.abort();
        return payload;
      },
    });
    for await (const event of stream) {
      if (event.type === 'done' || event.type === 'error') break;
    }
    if (!captured) throw new Error('Pi provider payload was not captured');
    return captured;
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}
