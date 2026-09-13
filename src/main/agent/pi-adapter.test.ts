import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IRIS_AGENT_PROMPT } from './prompt';
import {
  instrumentProviderPayloads,
  loadIrisModelCatalog,
  loadIrisProviderCatalog,
  normalizeIrisProviderContext,
  renderPromptContent,
  resolveIrisModelBaseUrl,
  renderRawError,
  renderRawHttpFailure,
  restoreIrisPiHistory,
  storedPiCredentialSecrets,
  toIrisModelOption,
  unwrapProviderErrorMessage,
  IrisHistoryManager,
} from './pi-adapter';
import {
  addIrisAgentProviderProfile,
  loadStoredIrisAgentProviderProfiles,
  removeIrisAgentProviderProfile,
  updateIrisAgentProviderProfileApiKey,
  updateIrisAgentProviderModels,
  runtimeProviderId,
} from './provider-profiles';

describe('Iris Pi adapter', () => {
  it('preserves raw HTTP bodies and transport cause chains', () => {
    const transport = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('Connect Timeout Error'), {
        name: 'ConnectTimeoutError',
        code: 'UND_ERR_CONNECT_TIMEOUT',
        address: 'example.test',
        port: 443,
      }),
    });

    expect(renderRawError(transport)).toBe([
      'Error: fetch failed',
      'caused by ConnectTimeoutError [UND_ERR_CONNECT_TIMEOUT]: Connect Timeout Error (address=example.test, port=443)',
    ].join('\n'));
    expect(renderRawHttpFailure(503, 'Service Unavailable', '{"type":"shell_api_error"}'))
      .toBe('HTTP 503 Service Unavailable\n{"type":"shell_api_error"}');
    expect(unwrapProviderErrorMessage(
      'OpenAI API error (503): {"type":"shell_api_error"}',
    )).toBe('HTTP 503\n{"type":"shell_api_error"}');
    expect(unwrapProviderErrorMessage(
      'OpenAI API error: Request timed out.',
      renderRawError(transport),
    )).toBe(renderRawError(transport));
  });

  it('uses the built-in Iris prompt without discovered resources', () => {
    expect(IRIS_AGENT_PROMPT).toContain('operating inside Iris Agent');
  });

  it('injects persisted provider messages and tool results into Pi context', () => {
    const manager = new IrisHistoryManager();
    restoreIrisPiHistory(manager, {
      revision: 9,
      anchor: { kind: 'workspace', path: '.iris' },
      messages: [
        { id: 'u1', intentId: 'turn-1', role: 'user', content: 'novel', createdAt: 1 },
        {
          id: 'a1',
          intentId: 'turn-1',
          role: 'assistant',
          content: 'partial chapter',
          createdAt: 2,
          toolCalls: [{ id: 'call-1', tool: 'read', input: { path: 'chapter.md' } }],
        },
        {
          id: 't1',
          intentId: 'turn-1',
          role: 'tool',
          content: [{ type: 'text', text: 'tool output' }],
          createdAt: 3,
          toolCallId: 'call-1',
          tool: 'read',
          isError: false,
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
    expect(messages[2]).toMatchObject({ content: [{ type: 'text', text: 'tool output' }] });
  });

  it('rejects legacy string tool history at the Pi boundary', () => {
    const manager = new IrisHistoryManager();
    expect(() => restoreIrisPiHistory(manager, {
      revision: 1,
      anchor: { kind: 'workspace', path: '.iris' },
      messages: [{
        id: 'tool-1', intentId: 'intent-1', role: 'tool', content: 'invalid', createdAt: 1,
        toolCallId: 'call-1', tool: 'read',
      }],
    })).toThrow(/expected an array of content blocks/);
  });

  it('attaches the request images to the same user message as the prompt', () => {
    const attachment = {
      id: 'd'.repeat(64), name: 'shot.png', mimeType: 'image/png' as const, bytes: 3, width: 8, height: 6,
    };
    // The request is one turn: its picture rides on the same user message as the
    // assembled prompt, not on a second message the provider would correlate.
    expect(renderPromptContent('看看这张图', [
      { type: 'image', attachment, dataBase64: 'AAAA' },
    ])).toEqual([
      { type: 'text', text: '看看这张图' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
    // A request without images keeps the plain string form, so every existing
    // provider path is untouched.
    expect(renderPromptContent('只发文字')).toBe('只发文字');
    expect(renderPromptContent('只发文字', [])).toBe('只发文字');
  });

  it('does not claim image input for a model that does not declare it', () => {
    const withImages = toIrisModelOption({
      provider: 'openai', id: 'vision', name: 'Vision', api: 'openai-responses',
      reasoning: false, input: ['text', 'image'],
    });
    expect(withImages.capabilities).toEqual({ input: ['text', 'image'] });
    const textOnly = toIrisModelOption({
      provider: 'openai', id: 'text', name: 'Text', api: 'openai-responses',
      reasoning: false, input: ['text'],
    });
    expect(textOnly.capabilities).toEqual({ input: ['text'] });
    // A catalog that says nothing is unknown, never silently text-only.
    expect(toIrisModelOption({
      provider: 'openai', id: 'unknown', name: 'Unknown', api: 'openai-responses', reasoning: false,
    }).capabilities).toEqual({ input: [] });
  });

  it('replays a stored image into the provider context with its bytes', () => {
    const attachment = {
      id: 'c'.repeat(64), name: 'shot.png', mimeType: 'image/png' as const, bytes: 3, width: 8, height: 6,
    };
    const manager = new IrisHistoryManager();
    restoreIrisPiHistory(manager, {
      revision: 2,
      anchor: { kind: 'workspace', path: '.iris' },
      messages: [
        {
          id: 'a1',
          intentId: 'intent-1',
          turnId: 'turn-1',
          role: 'assistant',
          content: '',
          createdAt: 1,
          toolCalls: [{ id: 'call-1', tool: 'read', input: { path: 'shot.png' } }],
        },
        {
          id: 't1',
          intentId: 'intent-1',
          turnId: 'turn-1',
          role: 'tool',
          content: [
            { type: 'text', text: 'shot.png: image image/png 8x6 (3 B).' },
            { type: 'image', attachment, dataBase64: 'AAAA' },
          ],
          attachments: [attachment],
          createdAt: 2,
          toolCallId: 'call-1',
          tool: 'read',
          isError: false,
        },
      ],
    });
    const messages = manager.buildSessionContext().messages;
    expect(messages[1]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      content: [
        { type: 'text', text: 'shot.png: image image/png 8x6 (3 B).' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    });
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
    const manager = new IrisHistoryManager();
    restoreIrisPiHistory(manager, {
      revision: 2,
      anchor: { kind: 'workspace', path: '.iris' },
      messages: [
        { id: 'u1', intentId: 'turn-1', role: 'user', content: 'write a novel', createdAt: 1 },
        {
          id: 'a1',
          intentId: 'turn-1',
          role: 'assistant',
          content: 'partial chapter',
          createdAt: 2,
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
    const manager = new IrisHistoryManager();
    restoreIrisPiHistory(manager, {
      revision: 1,
      anchor: { kind: 'workspace', path: '.iris' },
      messages: [
        { id: 'u1', intentId: 'turn-1', role: 'user', content: 'question', createdAt: 1 },
        { id: 'a1', intentId: 'turn-1', role: 'assistant', content: 'legacy answer', createdAt: 2 },
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

  it('injects the configured provider fetch into Pi requests', () => {
    let receivedFetch: typeof globalThis.fetch | undefined;
    const runtime = {
      streamSimple: vi.fn((_model, _context, options) => {
        receivedFetch = options.fetch;
        return { marker: 'stream' };
      }),
    };
    const providerFetch = vi.fn() as unknown as typeof globalThis.fetch;
    instrumentProviderPayloads(runtime as never, undefined, undefined, providerFetch);

    expect(runtime.streamSimple({} as never, { messages: [] } as never, {})).toEqual({ marker: 'stream' });
    expect(receivedFetch).toBe(providerFetch);
  });

  it('owns the model list: Pi builtin providers are never a model source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iris-provider-ownership-'));
    const originalFetch = globalThis.fetch;
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'managed-model' }] }), { status: 200 }));
    // A leftover Pi credential and a Pi environment key would make Pi's builtin
    // OpenAI provider "available" inside the embedded runtime.
    await writeFile(join(root, 'auth.json'), JSON.stringify({
      openai: { type: 'api_key', key: 'sk-pi-builtin' },
    }), 'utf8');
    process.env.OPENAI_API_KEY = 'sk-pi-env';
    try {
      expect(storedPiCredentialSecrets('openai', root)).toEqual({
        type: 'api_key',
        key: 'sk-pi-builtin',
      });

      const unconfigured = await loadIrisModelCatalog(root, root);
      expect(unconfigured.models).toEqual([]);
      const catalog = await loadIrisProviderCatalog(root);
      expect(catalog.profiles).toEqual([]);
      expect('providers' in catalog).toBe(false);

      await addIrisAgentProviderProfile({
        name: 'Managed provider',
        templateId: 'openai-compatible',
        baseUrl: 'https://managed.example.com/v1',
        apiKey: 'sk-managed',
      }, root);
      const managed = await loadIrisModelCatalog(root, root, true);
      expect(managed.models).toHaveLength(1);
      expect(managed.models[0]).toMatchObject({
        providerName: 'Managed provider',
        modelId: 'managed-model',
      });
      expect(managed.models.every((model) => model.provider.startsWith('iris-profile-'))).toBe(true);
      expect(JSON.stringify(managed)).not.toContain('sk-managed');
      expect(JSON.stringify(managed)).not.toContain('sk-pi');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists multiple profiles for one template and registers separate model providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iris-provider-profiles-'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/v1\/models$/u);
      expect(init?.headers).toMatchObject({ authorization: expect.stringMatching(/^Bearer sk-/u) });
      return new Response(JSON.stringify({ data: [{ id: 'gpt-available' }] }), { status: 200 });
    });
    try {
      await expect(addIrisAgentProviderProfile({
        name: 'Missing endpoint',
        templateId: 'openai-compatible',
        baseUrl: '',
        apiKey: 'sk-not-saved',
      }, root)).rejects.toThrow('requires a Base URL');
      const firstProjection = await addIrisAgentProviderProfile({
        name: 'OpenAI primary',
        templateId: 'openai',
        baseUrl: '',
        apiKey: 'sk-primary-secret',
      }, root);
      const secondProjection = await addIrisAgentProviderProfile({
        name: 'OpenAI backup',
        templateId: 'openai',
        baseUrl: 'https://proxy.example.com/v1',
        apiKey: 'sk-backup-secret',
      }, root);

      expect(firstProjection).toHaveLength(1);
      expect(secondProjection).toHaveLength(2);
      expect(secondProjection.map((profile) => profile.hasCredential)).toEqual([true, true]);
      expect(JSON.stringify(secondProjection)).not.toContain('secret');
      const stored = await loadStoredIrisAgentProviderProfiles(root);
      expect(stored.map((profile) => profile.apiKey)).toEqual([
        'sk-primary-secret',
        'sk-backup-secret',
      ]);
      expect(stored[1]).toMatchObject({
        templateId: 'openai',
        baseUrl: 'https://proxy.example.com/v1',
      });
      await updateIrisAgentProviderModels(stored[0]!.id, [{
        modelId: 'gpt-available',
        displayName: 'GPT Available',
        contextWindowTokens: 96_000,
        maxOutputTokens: 12_000,
        reserveOutputTokens: 10_000,
        keepRecentTokens: 8_000,
        compactTrigger: 80_000,
        enabled: true,
        source: 'manual',
      }], root);

      const catalog = await loadIrisProviderCatalog(root);
      expect(catalog.templates.map((template) => template.id)).toContain('openai-compatible');
      expect(catalog.profiles.map((profile) => profile.name)).toEqual([
        'OpenAI primary',
        'OpenAI backup',
      ]);
      expect(catalog.profiles.map((profile) => profile.hasCredential)).toEqual([true, true]);
      expect(JSON.stringify(catalog.profiles)).not.toContain('secret');

      const updatedProjection = await updateIrisAgentProviderProfileApiKey(
        stored[0]!.id,
        'sk-replaced-secret',
        root,
      );
      expect(updatedProjection[0]).toMatchObject({ hasCredential: true });
      expect(JSON.stringify(updatedProjection)).not.toContain('sk-replaced-secret');
      expect((await loadStoredIrisAgentProviderProfiles(root))[0]?.apiKey).toBe('sk-replaced-secret');

      const modelCatalog = await loadIrisModelCatalog(root, root, true);
      expect(modelCatalog.models).toContainEqual(expect.objectContaining({
        provider: runtimeProviderId(stored[0]!.id),
        modelId: 'gpt-available',
        contextWindowTokens: 96_000,
        maxOutputTokens: 12_000,
        contextPolicy: {
          reserveOutputTokens: 10_000,
          keepRecentTokens: 8_000,
          compactTrigger: 80_000,
        },
        source: 'manual',
        enabled: true,
      }));
      const profileProviders = new Set(stored.map((profile) => runtimeProviderId(profile.id)));
      expect(profileProviders.size).toBe(2);
      expect(modelCatalog.models.filter((model) => profileProviders.has(model.provider))).toEqual(expect.arrayContaining([
        expect.objectContaining({ modelId: 'gpt-available', providerName: 'OpenAI primary' }),
        expect.objectContaining({ modelId: 'gpt-available', providerName: 'OpenAI backup' }),
      ]));
      expect(modelCatalog.models.some((model) =>
        profileProviders.has(model.provider) && model.modelId !== 'gpt-available')).toBe(false);
      expect(JSON.stringify(modelCatalog)).not.toContain('secret');

      const remaining = await removeIrisAgentProviderProfile(stored[0]!.id, root);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.name).toBe('OpenAI backup');
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps healthy provider models when another provider query fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iris-provider-model-query-'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => String(input).includes('healthy.example.com')
      ? new Response(JSON.stringify({ data: [{ id: 'healthy-model' }] }), { status: 200 })
      : new Response('upstream unavailable: sk-secret', { status: 502 }));
    try {
      await addIrisAgentProviderProfile({
        name: 'Healthy provider',
        templateId: 'openai-compatible',
        baseUrl: 'https://healthy.example.com/v1',
        apiKey: 'sk-healthy',
      }, root);
      await addIrisAgentProviderProfile({
        name: 'Unavailable provider',
        templateId: 'anthropic-compatible',
        baseUrl: 'https://provider.example.com',
        apiKey: 'sk-secret',
      }, root);

      const localCatalog = await loadIrisModelCatalog(root, root);
      expect(localCatalog.models.some((model) => model.providerName === 'Healthy provider')).toBe(false);
      expect(globalThis.fetch).not.toHaveBeenCalled();

      const catalog = await loadIrisModelCatalog(root, root, true);
      expect(catalog.models).toContainEqual(expect.objectContaining({
        modelId: 'healthy-model',
        providerName: 'Healthy provider',
      }));
      expect(catalog.models.some((model) => model.providerName === 'Unavailable provider')).toBe(false);
      expect(catalog.error).toContain(
        'Unavailable provider: Could not load models for Anthropic Compatible: HTTP 502',
      );
      expect(JSON.stringify(catalog)).not.toContain('sk-secret');

      const profiles = await loadStoredIrisAgentProviderProfiles(root);
      const healthy = profiles.find((profile) => profile.name === 'Healthy provider')!;
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockClear();
      await expect(resolveIrisModelBaseUrl(root, {
        provider: runtimeProviderId(healthy.id),
        modelId: 'healthy-model',
      })).resolves.toBe('https://healthy.example.com/v1');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('starts custom provider model discovery concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iris-provider-model-concurrent-'));
    const originalFetch = globalThis.fetch;
    let resolveSlow!: (response: Response) => void;
    const slowResponse = new Promise<Response>((resolve) => { resolveSlow = resolve; });
    globalThis.fetch = vi.fn(async (input) => String(input).includes('slow.example.com')
      ? slowResponse
      : new Response(JSON.stringify({ data: [{ id: 'fast-model' }] }), { status: 200 }));
    try {
      await addIrisAgentProviderProfile({
        name: 'Slow provider',
        templateId: 'openai-compatible',
        baseUrl: 'https://slow.example.com/v1',
        apiKey: 'sk-slow',
      }, root);
      await addIrisAgentProviderProfile({
        name: 'Fast provider',
        templateId: 'openai-compatible',
        baseUrl: 'https://fast.example.com/v1',
        apiKey: 'sk-fast',
      }, root);

      const pending = loadIrisModelCatalog(root, root, true);
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
      resolveSlow(new Response(JSON.stringify({ data: [{ id: 'slow-model' }] }), { status: 200 }));

      await expect(pending).resolves.toMatchObject({
        models: expect.arrayContaining([
          expect.objectContaining({ modelId: 'slow-model', providerName: 'Slow provider' }),
          expect.objectContaining({ modelId: 'fast-model', providerName: 'Fast provider' }),
        ]),
      });
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
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
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
      deepseek: { type: 'api_key', key: 'test-key' },
    }), 'utf8');
    const runtime = await (await import('./pi-adapter')).createIrisModelRuntimeForTest(agentDir, agentDir);
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

