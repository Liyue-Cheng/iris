import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getAgentDir,
  readStoredCredential,
  type CreateAgentSessionOptions,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type {
  AgentCommandShell,
  AgentHistorySnapshot,
  AgentProviderProxy,
  AgentTerminalIntent,
} from '@shared/agent-protocol';
import type {
  IrisAgentModelCatalog,
  IrisAgentModelOption,
  IrisAgentModelRef,
  IrisAgentProviderCatalog,
} from '@shared/types';
import { IRIS_AGENT_PROMPT } from './prompt';
import {
  IRIS_AGENT_PROVIDER_TEMPLATES,
  loadStoredIrisAgentProviderProfiles,
  profileModelsConfig,
  profilesForRenderer,
  runtimeProviderId,
} from './provider-profiles';

export const IRIS_PI_VERSION = VERSION;
export const IRIS_PI_TOOL_NAMES = ['read', 'edit', 'write', 'terminal'] as const;

const irisToolCallContext = new AsyncLocalStorage<string>();
const irisTerminalIntentContext = new AsyncLocalStorage<AgentTerminalIntent>();

export function currentIrisProviderToolCallId(): string | undefined {
  return irisToolCallContext.getStore();
}

interface IrisTerminalOperations {
  exec: (
    command: string,
    intent: AgentTerminalIntent,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

export function irisPiAgentDir(): string {
  return getAgentDir();
}

export interface IrisToolHostOperations {
  read: ReadOperations;
  edit: EditOperations;
  write: WriteOperations;
  terminal: IrisTerminalOperations;
}

export function hasStoredPiCredential(providerId: string, authPath?: string): boolean {
  return readStoredCredential(providerId, authPath) !== undefined;
}

export function storedPiCredentialSecrets(providerId: string, agentDir: string): unknown {
  return readStoredCredential(providerId, join(agentDir, 'auth.json'));
}

export async function createIrisPiResourceLoader(cwd: string, agentDir: string) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: IRIS_AGENT_PROMPT,
    systemPromptOverride: () => IRIS_AGENT_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  return loader;
}

export function createIrisPiToolDefinitions(
  cwd: string,
  operations: IrisToolHostOperations,
  commandShell: AgentCommandShell = defaultToolShell(),
) {
  const terminalBase = createBashToolDefinition(cwd, {
    operations: {
      exec: (command, commandCwd, options) => {
        const intent = irisTerminalIntentContext.getStore();
        if (!intent) throw new Error('Iris terminal intent context is missing.');
        return operations.terminal.exec(command, intent, commandCwd, options);
      },
    },
    exposeSessionEnvironment: false,
  });
  const terminalParameters = Type.Object({
    command: Type.String({ description: 'PowerShell or shell command to execute.' }),
    intent: Type.Union([
      Type.Literal('information'),
      Type.Literal('operation'),
    ], {
      description: 'Use information only for read-only inspection; otherwise use operation.',
    }),
    timeout: Type.Optional(Type.Number()),
  });
  const { prepareArguments: _legacyPrepareArguments, ...terminalBaseDefinition } = terminalBase;
  const terminal = {
    ...terminalBaseDefinition,
    parameters: terminalParameters,
    execute: (
      toolCallId: string,
      params: { command: string; intent: AgentTerminalIntent; timeout?: number },
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof terminalBase.execute>[3],
      context: Parameters<typeof terminalBase.execute>[4],
    ) => irisTerminalIntentContext.run(
      params.intent,
      () => terminalBase.execute(
        toolCallId,
        { command: params.command, ...(params.timeout === undefined ? {} : { timeout: params.timeout }) },
        signal,
        onUpdate,
        context,
      ),
    ),
  };
  return [
    withIrisToolCallContext(createReadToolDefinition(cwd, { operations: operations.read })),
    withIrisToolCallContext(createEditToolDefinition(cwd, { operations: operations.edit })),
    withIrisToolCallContext(createWriteToolDefinition(cwd, { operations: operations.write })),
    withIrisToolCallContext({
      ...terminal,
      name: 'terminal',
      label: commandShell.kind === 'powershell' ? 'PowerShell' : 'Terminal',
      description: commandShell.kind === 'powershell'
        ? `Execute a PowerShell command in the current project with ${commandShell.displayName} (${commandShell.executable}). Returns stdout, stderr, and the exit code. The intent field is required: information is only for read-only inspection; operation is for commands that may have side effects.`
        : `Execute a shell command in the current project with ${commandShell.displayName}. Returns stdout, stderr, and the exit code. The intent field is required: information is only for read-only inspection; operation is for commands that may have side effects.`,
      promptSnippet: commandShell.kind === 'powershell'
        ? `Execute visible PowerShell commands with ${commandShell.displayName}`
        : `Execute visible commands with ${commandShell.displayName}`,
      promptGuidelines: commandShell.kind === 'powershell'
        ? [
            'Use PowerShell syntax and quoting. Do not emit Bash-only commands, operators, or environment-variable syntax.',
            'Set intent to information only for read-only inspection. Use operation for tests, builds, installs, process control, writes, and uncertain commands.',
          ]
        : [
            `Use the ${commandShell.displayName} shell dialect and quoting.`,
            'Set intent to information only for read-only inspection. Use operation for tests, builds, installs, process control, writes, and uncertain commands.',
          ],
    }),
  ] as const;
}

function withIrisToolCallContext<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate, context) =>
      irisToolCallContext.run(
        toolCallId,
        () => tool.execute(toolCallId, params, signal, onUpdate, context),
      ),
  };
}

export async function loadIrisModelCatalog(
  agentDir: string,
  profileRoot: string,
): Promise<IrisAgentModelCatalog> {
  try {
    const runtime = await createIrisModelRuntime(agentDir, profileRoot);
    const profiles = await loadProviderProfiles(profileRoot);
    const profileNames = new Map(
      profiles.map((profile) => [runtimeProviderId(profile.id), profile.name]),
    );
    const models = (await runtime.getAvailable())
      .map((model) => toIrisModelOption(model, profileNames.get(model.provider)))
      .sort(compareModels);
    const runtimeError = runtime.getError();
    return { models, ...(runtimeError ? { error: runtimeError } : {}) };
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadIrisProviderCatalog(
  agentDir: string,
  profileRoot: string,
): Promise<IrisAgentProviderCatalog> {
  try {
    const runtime = await createIrisModelRuntime(agentDir, profileRoot, false);
    const credentials = new Map(
      (await runtime.listCredentials()).map((credential) => [credential.providerId, credential]),
    );
    const providers = runtime.getProviders().map((provider) => {
      const status = runtime.getProviderAuthStatus(provider.id);
      const credential = credentials.get(provider.id);
      return {
        providerId: provider.id,
        name: provider.name,
        configured: status.configured,
        hasStoredCredential: credential !== undefined,
        ...(credential ? { credentialType: credential.type } : {}),
        ...(status.source ? { source: status.source } : {}),
        supportsApiKey: provider.auth.apiKey?.login !== undefined,
        supportsOAuth: provider.auth.oauth !== undefined,
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
    const runtimeError = runtime.getError();
    const profiles = await loadProviderProfiles(profileRoot);
    return {
      providers,
      templates: [...IRIS_AGENT_PROVIDER_TEMPLATES],
      profiles: profilesForRenderer(profiles),
      ...(runtimeError ? { error: runtimeError } : {}),
    };
  } catch (error) {
    const profiles = await loadProviderProfiles(profileRoot).catch(() => []);
    return {
      providers: [],
      templates: [...IRIS_AGENT_PROVIDER_TEMPLATES],
      profiles: profilesForRenderer(profiles),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function saveIrisProviderApiKey(
  providerId: string,
  apiKey: string,
  agentDir: string,
  profileRoot: string,
): Promise<IrisAgentProviderCatalog> {
  const normalizedProviderId = providerId.trim();
  const normalizedApiKey = apiKey.trim();
  if (!normalizedProviderId) throw new Error('Provider is required.');
  if (!normalizedApiKey) throw new Error('API key is required.');
  if (normalizedApiKey.length > 20_000) throw new Error('API key is too long.');

  const runtime = await createIrisModelRuntime(agentDir, profileRoot);
  const provider = runtime.getProvider(normalizedProviderId);
  if (!provider) throw new Error(`Unknown provider: ${normalizedProviderId}`);
  if (!provider.auth.apiKey?.login) {
    throw new Error(`${provider.name} does not support API key setup.`);
  }
  let answeredSecretPrompt = false;
  await runtime.login(normalizedProviderId, 'api_key', {
    prompt: async (prompt) => {
      if (prompt.type !== 'secret' || answeredSecretPrompt) {
        throw new Error(
          `${provider.name} requires an interactive login flow that Iris does not support yet.`,
        );
      }
      answeredSecretPrompt = true;
      return normalizedApiKey;
    },
    notify: () => undefined,
  });
  if (!answeredSecretPrompt) throw new Error(`${provider.name} did not request an API key.`);
  return loadIrisProviderCatalog(agentDir, profileRoot);
}

export async function removeIrisProviderCredential(
  providerId: string,
  agentDir: string,
  profileRoot: string,
): Promise<IrisAgentProviderCatalog> {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId) throw new Error('Provider is required.');
  const runtime = await createIrisModelRuntime(agentDir, profileRoot);
  if (!runtime.getProvider(normalizedProviderId)) {
    throw new Error(`Unknown provider: ${normalizedProviderId}`);
  }
  await runtime.logout(normalizedProviderId);
  return loadIrisProviderCatalog(agentDir, profileRoot);
}

export async function createIrisPiSession(
  options: Omit<
    CreateAgentSessionOptions,
    | 'cwd'
    | 'resourceLoader'
    | 'sessionManager'
    | 'settingsManager'
    | 'tools'
    | 'customTools'
    | 'modelRuntime'
    | 'model'
  > & {
    cwd: string;
    agentDir: string;
    providerProfileRoot: string;
    operations: IrisToolHostOperations;
    history: AgentHistorySnapshot;
    model: IrisAgentModelRef;
    commandShell: AgentCommandShell;
    providerProxy: AgentProviderProxy;
    onProviderPayload?: (
      payload: unknown,
      model: { provider: string; id: string; api: string },
    ) => void | Promise<void>;
    onProviderFailure?: (
      failure: string | null,
      model: { provider: string; id: string; api: string },
    ) => void | Promise<void>;
  },
) {
  const {
    cwd,
    agentDir,
    providerProfileRoot,
    operations,
    history,
    model: modelRef,
    commandShell,
    providerProxy,
    onProviderPayload,
    onProviderFailure,
    ...piOptions
  } = options;
  const resourceLoader = await createIrisPiResourceLoader(cwd, agentDir);
  const sessionManager = SessionManager.inMemory(cwd);
  restoreIrisPiHistory(sessionManager, history);
  const modelRuntime = await createIrisModelRuntime(agentDir, providerProfileRoot);
  const model = modelRuntime.getModel(modelRef.provider, modelRef.modelId);
  if (!model) {
    throw new Error(
      `Configured Iris Agent model was not found: ${modelRef.provider}/${modelRef.modelId}`,
    );
  }
  const transport = createProviderTransport(providerProxy);
  instrumentProviderPayloads(modelRuntime, onProviderPayload, onProviderFailure, transport.fetch);
  try {
    const result = await createAgentSession({
      ...piOptions,
      cwd,
      agentDir,
      resourceLoader,
      sessionManager,
      model,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      tools: [...IRIS_PI_TOOL_NAMES],
      customTools: createIrisPiToolDefinitions(cwd, operations, commandShell) as unknown as NonNullable<
        CreateAgentSessionOptions['customTools']
      >,
    });
    return { ...result, disposeProviderTransport: transport.dispose };
  } catch (error) {
    await transport.dispose();
    throw error;
  }
}

export async function resolveIrisModelBaseUrl(
  agentDir: string,
  profileRoot: string,
  modelRef: IrisAgentModelRef,
): Promise<string> {
  const runtime = await createIrisModelRuntime(agentDir, profileRoot);
  const model = runtime.getModel(modelRef.provider, modelRef.modelId);
  if (!model) {
    throw new Error(`Configured Iris Agent model was not found: ${modelRef.provider}/${modelRef.modelId}`);
  }
  return model.baseUrl;
}

function createProviderTransport(providerProxy: AgentProviderProxy): {
  fetch?: typeof globalThis.fetch;
  dispose: () => Promise<void>;
} {
  if (providerProxy.mode === 'direct') {
    return { dispose: async () => undefined };
  }
  const dispatcher = new ProxyAgent(providerProxy.url);
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as never, { ...init, dispatcher } as never)) as unknown as typeof globalThis.fetch;
  return {
    fetch: proxyFetch,
    dispose: () => dispatcher.close(),
  };
}

async function createIrisModelRuntime(
  agentDir: string,
  profileRoot: string,
  loadProfileModels = true,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
  });
  const profiles = await loadProviderProfiles(profileRoot);
  if (!loadProfileModels) return runtime;
  for (const profile of profiles) {
    const template = IRIS_AGENT_PROVIDER_TEMPLATES.find(
      (candidate) => candidate.id === profile.templateId,
    );
    if (!template) continue;
    const baseUrl = profile.baseUrl || template.defaultBaseUrl;
    const modelIds = await fetchIrisProviderModelIds(template, baseUrl, profile.apiKey);
    runtime.registerProvider(runtimeProviderId(profile.id), {
      name: profile.name,
      ...(baseUrl ? { baseUrl } : {}),
      api: template.api,
      apiKey: profile.apiKey,
      models: profileModelsConfig(runtime.getModels(template.sourceProvider), template.api, modelIds),
    });
  }
  return runtime;
}

function loadProviderProfiles(profileRoot: string) {
  return loadStoredIrisAgentProviderProfiles(profileRoot);
}

async function fetchIrisProviderModelIds(
  template: typeof IRIS_AGENT_PROVIDER_TEMPLATES[number],
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const endpoint = new URL(
    template.api === 'anthropic-messages' ? 'v1/models' : 'models',
    `${baseUrl.replace(/\/+$/u, '')}/`,
  );
  const headers: Record<string, string> = template.api === 'anthropic-messages'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` };
  let response: Response;
  try {
    response = await fetch(endpoint, { headers });
  } catch (error) {
    throw new Error(`Could not load models for ${template.name}: ${renderRawError(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Could not load models for ${template.name}: HTTP ${response.status} ${response.statusText}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Could not load models for ${template.name}: response was not valid JSON.`);
  }
  const data = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { data?: unknown }).data
    : undefined;
  if (!Array.isArray(data)) {
    throw new Error(`Could not load models for ${template.name}: response did not contain a model list.`);
  }
  const modelIds = [...new Set(data.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const id = (item as { id?: unknown }).id;
    return typeof id === 'string' && id.trim() ? [id.trim()] : [];
  }))];
  if (!modelIds.length) {
    throw new Error(`Could not load models for ${template.name}: response contained no models.`);
  }
  return modelIds;
}

function toIrisModelOption(model: {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
}, providerName?: string): IrisAgentModelOption {
  return {
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    ...(providerName ? { providerName } : {}),
  };
}

function compareModels(left: IrisAgentModelOption, right: IrisAgentModelOption): number {
  return left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name);
}

function defaultToolShell(): AgentCommandShell {
  return process.platform === 'win32'
    ? { kind: 'powershell', executable: 'powershell.exe', displayName: 'Windows PowerShell' }
    : {
        kind: 'posix',
        executable: process.env.SHELL || '/bin/bash',
        displayName: process.env.SHELL || '/bin/bash',
      };
}

export function restoreIrisPiHistory(
  sessionManager: SessionManager,
  history: AgentHistorySnapshot,
): void {
  for (const item of history.messages) {
    sessionManager.appendMessage(toPiHistoryMessage(item));
  }
}

export function instrumentProviderPayloads(
  modelRuntime: ModelRuntime,
  capture?: (
    payload: unknown,
    model: { provider: string; id: string; api: string },
  ) => void | Promise<void>,
  captureFailure?: (
    failure: string | null,
    model: { provider: string; id: string; api: string },
  ) => void | Promise<void>,
  providerFetch?: typeof globalThis.fetch,
): void {
  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = ((model, context, options) => {
    const modelIdentity = { provider: model.provider, id: model.id, api: model.api };
    const upstreamFetch = providerFetch ?? options?.fetch ?? globalThis.fetch;
    const observedFetch: typeof globalThis.fetch | undefined = captureFailure
      ? async (input, init) => {
          await captureProviderFailure(captureFailure, null, modelIdentity);
          try {
            const response = await upstreamFetch(input, init);
            if (!response.ok) {
              let body = '';
              try {
                body = await response.clone().text();
              } catch (error) {
                body = renderRawError(error);
              }
              await captureProviderFailure(
                captureFailure,
                renderRawHttpFailure(response.status, response.statusText, body),
                modelIdentity,
              );
            }
            return response;
          } catch (error) {
            await captureProviderFailure(captureFailure, renderRawError(error), modelIdentity);
            throw error;
          }
        }
      : providerFetch;

    return streamSimple(model, normalizeIrisProviderContext(context), {
      ...options,
      ...(observedFetch ? { fetch: observedFetch } : {}),
      onPayload: async (payload, providerModel) => {
        const transformed = await options?.onPayload?.(payload, providerModel);
        const providerPayload = transformed === undefined ? payload : transformed;
        if (capture) {
          try {
            await capture(providerPayload, {
              provider: providerModel.provider,
              id: providerModel.id,
              api: providerModel.api,
            });
          } catch {
            // Context observability must never make a provider request fail.
          }
        }
        return transformed;
      },
    });
  }) as ModelRuntime['streamSimple'];
}

async function captureProviderFailure(
  capture: NonNullable<Parameters<typeof instrumentProviderPayloads>[2]>,
  failure: string | null,
  model: { provider: string; id: string; api: string },
): Promise<void> {
  try {
    await capture(failure, model);
  } catch {
    // Error observability must never change provider request behavior.
  }
}

export function renderRawHttpFailure(status: number, statusText: string, body: string): string {
  const statusLine = `HTTP ${status}${statusText.trim() ? ` ${statusText.trim()}` : ''}`;
  return body ? `${statusLine}\n${body}` : statusLine;
}

export function renderRawError(error: unknown): string {
  const seen = new Set<unknown>();
  const lines: string[] = [];
  appendRawError(error, lines, seen, '');
  return lines.join('\n') || String(error);
}

export function unwrapProviderErrorMessage(message: string, capturedFailure?: string | null): string {
  if (capturedFailure) return capturedFailure;
  const statusMatch = message.match(
    /^(?:OpenAI|Anthropic|Azure OpenAI) API error \((\d{3})\):\s*([\s\S]*)$/u,
  );
  if (statusMatch) return renderRawHttpFailure(Number(statusMatch[1]), '', statusMatch[2] ?? '');
  return message.replace(/^(?:OpenAI|Anthropic|Azure OpenAI) API error:\s*/u, '');
}

function appendRawError(
  error: unknown,
  lines: string[],
  seen: Set<unknown>,
  prefix: string,
): void {
  if (!isErrorRecord(error) || seen.has(error)) {
    lines.push(`${prefix}${String(error)}`);
    return;
  }
  seen.add(error);
  const name = typeof error.name === 'string' && error.name ? error.name : 'Error';
  const message = typeof error.message === 'string' ? error.message : String(error);
  const code = typeof error.code === 'string' || typeof error.code === 'number'
    ? ` [${String(error.code)}]`
    : '';
  const details = ['errno', 'syscall', 'address', 'port']
    .flatMap((key) => {
      const value = error[key];
      return typeof value === 'string' || typeof value === 'number'
        ? [`${key}=${String(value)}`]
        : [];
    });
  lines.push(`${prefix}${name}${code}: ${message}${details.length ? ` (${details.join(', ')})` : ''}`);
  if ('cause' in error && error.cause !== undefined) {
    appendRawError(error.cause, lines, seen, 'caused by ');
  }
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) appendRawError(nested, lines, seen, 'error: ');
  }
}

function isErrorRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type IrisPiContext = Parameters<ModelRuntime['streamSimple']>[1];
type IrisPiAssistantMessage = Extract<IrisPiContext['messages'][number], { role: 'assistant' }>;

export function normalizeIrisProviderContext(context: IrisPiContext): IrisPiContext {
  const messages: IrisPiContext['messages'] = [];

  for (let index = 0; index < context.messages.length;) {
    const message = context.messages[index]!;
    if (message.role === 'assistant' && message.stopReason === 'aborted') {
      const safeText = providerSafeAssistantText(message);
      if (safeText) messages.push(safeText);
      index += 1;
      continue;
    }

    if (message.role === 'assistant') {
      const toolCallIds = assistantToolCallIds(message);
      if (toolCallIds.length === 0) {
        messages.push(message);
        index += 1;
        continue;
      }

      const uniqueToolCallIds = new Set(toolCallIds);
      const pending = new Set(toolCallIds);
      const results: IrisPiContext['messages'] = [];
      let resultIndex = index + 1;
      while (context.messages[resultIndex]?.role === 'toolResult') {
        const result = context.messages[resultIndex];
        if (result?.role === 'toolResult' && pending.delete(result.toolCallId)) {
          results.push(result);
        }
        resultIndex += 1;
      }

      if (uniqueToolCallIds.size === toolCallIds.length && pending.size === 0) {
        messages.push(message, ...results);
      } else {
        const safeText = providerSafeAssistantText(message);
        if (safeText) messages.push(safeText);
      }
      index = resultIndex;
      continue;
    }

    if (message.role === 'toolResult') {
      index += 1;
      continue;
    }
    messages.push(message);
    index += 1;
  }

  return { ...context, messages };
}

function assistantToolCallIds(message: IrisPiAssistantMessage): string[] {
  return message.content.flatMap((block) => block.type === 'toolCall' ? [block.id] : []);
}

function providerSafeAssistantText(
  message: IrisPiAssistantMessage,
): IrisPiAssistantMessage | null {
  const content: IrisPiAssistantMessage['content'] = message.content.flatMap((block) =>
    block.type === 'text' && block.text.length > 0
      ? [{ type: 'text' as const, text: block.text }]
      : []);
  if (content.length === 0) return null;
  return {
    role: 'assistant',
    content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    usage: message.usage,
    stopReason: 'stop',
    timestamp: message.timestamp,
  };
}

export function normalizeIrisInterruptedAssistantMessage(
  message: unknown,
): Record<string, unknown> | null {
  if (!isPiMessage(message) || message.role !== 'assistant') return null;
  return providerSafeAssistantText(message as unknown as IrisPiAssistantMessage) as unknown as
    Record<string, unknown> | null;
}

function toPiHistoryMessage(
  item: AgentHistorySnapshot['messages'][number],
): Parameters<SessionManager['appendMessage']>[0] {
  if (isPiMessage(item.providerMessage)) {
    return item.providerMessage as unknown as Parameters<SessionManager['appendMessage']>[0];
  }
  if (item.role === 'assistant') {
    return {
      role: 'assistant',
      content: item.content ? [{ type: 'text', text: item.content }] : [],
      api: 'openai-responses',
      provider: 'iris-history',
      model: 'unknown',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'aborted',
      timestamp: item.createdAt,
    };
  }
  return {
    role: 'user',
    content: item.role === 'tool' ? `[Historical tool result]\n${item.content}` : item.content,
    timestamp: item.createdAt,
  };
}

function isPiMessage(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const role = (value as Record<string, unknown>).role;
  return role === 'user' || role === 'assistant' || role === 'toolResult';
}
