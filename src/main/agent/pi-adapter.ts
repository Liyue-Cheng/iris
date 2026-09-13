import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from '@earendil-works/pi-ai/compat';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { Type } from 'typebox';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type {
  AgentCommandShell,
  AgentHistorySnapshot,
  AgentPromptImage,
  AgentProviderProxy,
  AgentTerminalIntent,
} from '@shared/agent-protocol';
import type { AgentToolOperationResult } from '@shared/agent-protocol';
import type { IrisAgentImageMimeType } from '@shared/types';
import { AGENT_TERMINAL_MAX_TIMEOUT_SECONDS } from './command-pty';
import type {
  IrisAgentConfiguredModel,
  IrisAgentModelCatalog,
  IrisAgentModelOption,
  IrisAgentModelRef,
  IrisAgentProviderCatalog,
  IrisAgentThinkingLevel,
} from '@shared/types';
import { IRIS_AGENT_PROMPT } from './prompt';
import { renderReadImageSummary } from './tool-result-content';
import type { TextEdit } from './edit-diff';
import {
  IRIS_AGENT_PROVIDER_TEMPLATES,
  findIrisAgentProviderTemplate,
  loadStoredIrisAgentProviderProfiles,
  profileModelsConfig,
  profilesForRenderer,
  runtimeProviderId,
} from './provider-profiles';
import { enabledJtpToolIds, JTP_BUILTIN_TOOLS } from './jtp';

export const IRIS_EXECUTOR_VERSION = 'iris-executor-1';
export const IRIS_PI_TOOL_NAMES = [
  'read', 'edit', 'write', 'terminal',
  'task_start', 'task_get', 'task_list', 'task_cancel',
] as const;

const irisToolCallContext = new AsyncLocalStorage<string>();
const irisTerminalContext = new AsyncLocalStorage<{
  intent: AgentTerminalIntent;
  successExitCodes: number[];
}>();

export function currentIrisProviderToolCallId(): string | undefined {
  return irisToolCallContext.getStore();
}

interface IrisTerminalOperations {
  exec: (
    command: string,
    intent: AgentTerminalIntent,
    successExitCodes: number[],
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      env?: NodeJS.ProcessEnv;
      timeout?: number;
    },
  ) => Promise<{ exitCode: number | null }>;
}

export function irisPiAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured ? configured.replace(/^~(?=$|[\\/])/u, homedir()) : join(homedir(), '.pi', 'agent');
}

/**
 * One file read, already classified. A text read is a string; an image read
 * carries the base64 the provider needs plus the metadata the model is told
 * about, so the tool layer never has to guess from a byte blob.
 */
export type IrisReadFileResult =
  | { kind: 'text'; text: string }
  | {
      kind: 'image';
      mimeType: IrisAgentImageMimeType;
      dataBase64: string;
      bytes: number;
      width?: number;
      height?: number;
    };

export interface IrisToolHostOperations {
  read: {
    access: (absolutePath: string) => Promise<void>;
    readFile: (absolutePath: string, options?: { offset?: number; limit?: number }) => Promise<Buffer>;
    readMediaFile: (absolutePath: string, options?: { offset?: number; limit?: number }) => Promise<IrisReadFileResult>;
  };
  edit: {
    access: (absolutePath: string) => Promise<void>;
    readFile: (absolutePath: string) => Promise<Buffer>;
    writeFile: (absolutePath: string, edits: TextEdit[]) => Promise<void>;
  };
  write: {
    mkdir: (absolutePath: string) => Promise<void>;
    writeFile: (absolutePath: string, content: string) => Promise<void>;
  };
  terminal: IrisTerminalOperations;
  task?: {
    start: (command: string, title: string, successExitCodes?: number[]) => Promise<AgentToolOperationResult>;
    get: (taskId: string, cursor?: string, maxBytes?: number) => Promise<AgentToolOperationResult>;
    list: (scope?: 'active' | 'all', cursor?: string, limit?: number) => Promise<AgentToolOperationResult>;
    cancel: (taskId: string) => Promise<AgentToolOperationResult>;
  };
}

type StoredCredential = { type: 'api_key'; key: string };

async function readCredentialFile(path: string): Promise<Record<string, StoredCredential>> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([id, credential]) => {
      if (!credential || typeof credential !== 'object' || Array.isArray(credential)) return [];
      const item = credential as Record<string, unknown>;
      return item.type === 'api_key' && typeof item.key === 'string' ? [[id, { type: 'api_key', key: item.key }]] : [];
    }));
  } catch {
    return {};
  }
}

export function storedPiCredentialSecrets(providerId: string, agentDir: string): unknown {
  // Kept synchronous for the worker redaction hook. Iris no longer manages Pi's
  // builtin providers, but a stale Pi credential must still never leak into a
  // provider artifact if one is present.
  try {
    const text = readFileSync(join(agentDir, 'auth.json'), 'utf8');
    const credentials = JSON.parse(text) as Record<string, unknown>;
    return credentials[providerId];
  } catch {
    return undefined;
  }
}

export function createIrisPiToolDefinitions(
  cwd: string,
  operations: IrisToolHostOperations,
  commandShell: AgentCommandShell = defaultToolShell(),
) {
  const terminalParameters = Type.Object({
    command: Type.String({ description: 'PowerShell or shell command to execute.' }),
    intent: Type.Union([
      Type.Literal('information'),
      Type.Literal('operation'),
    ], {
      description: 'Use information only for read-only inspection; otherwise use operation.',
    }),
    timeout: Type.Number({
      description: `Hard foreground deadline in seconds (1-${AGENT_TERMINAL_MAX_TIMEOUT_SECONDS}).`,
      exclusiveMinimum: 0,
      maximum: AGENT_TERMINAL_MAX_TIMEOUT_SECONDS,
    }),
    successExitCodes: Type.Optional(Type.Array(Type.Integer(), {
      description: 'Exit codes that count as success. Defaults to [0].',
      minItems: 1,
      uniqueItems: true,
    })),
  });
  const terminal = {
    name: 'terminal',
    label: commandShell.kind === 'powershell' ? 'PowerShell' : 'Terminal',
    description: `Execute a visible ${commandShell.displayName} (${commandShell.executable}) command in the current project.`,
    promptGuidelines: [
      ...(commandShell.kind === 'powershell'
        ? ['Use PowerShell syntax and quoting. Do not emit Bash-only commands, operators, or environment-variable syntax.']
        : [`Use the ${commandShell.displayName} shell dialect and quoting.`]),
      'Set intent to information only for read-only inspection; use operation for side effects.',
      `Every call must provide a finite timeout in seconds no greater than ${AGENT_TERMINAL_MAX_TIMEOUT_SECONDS}. Use task_start for watches, servers, or commands without a reasonable finite bound.`,
    ],
    parameters: terminalParameters,
    execute: (
      _toolCallId: string,
      params: { command: string; intent: AgentTerminalIntent; timeout?: number; successExitCodes?: number[] },
      signal: AbortSignal | undefined,
      _onUpdate?: unknown,
      _context?: unknown,
    ) => irisTerminalContext.run(
      { intent: params.intent, successExitCodes: params.successExitCodes ?? [0] },
      async () => {
        const chunks: Buffer[] = [];
        const result = await operations.terminal.exec(
          params.command,
          params.intent,
          params.successExitCodes ?? [0],
          cwd,
          {
            onData: (data) => chunks.push(data),
            ...(signal ? { signal } : {}),
            env: process.env,
            ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
          },
        );
        return { content: [{ type: 'text' as const, text: chunks.length ? Buffer.concat(chunks).toString('utf8') : `exit code: ${String(result.exitCode)}` }], details: result };
      },
    ),
  };
  const taskStart = withIrisToolCallContext({
    name: 'task_start',
    label: 'Background task',
    description: 'Start an independent background task. It has its own task card and no foreground timeout.',
    promptGuidelines: ['Use for watch processes, development servers, interactive commands, or long-running work.'],
    parameters: Type.Object({
      command: Type.String({ description: 'PowerShell or shell command to run in the background.' }),
      title: Type.String({ description: 'Short human-readable title for the task card.' }),
      successExitCodes: Type.Optional(Type.Array(Type.Integer(), { minItems: 1, uniqueItems: true })),
    }),
    execute: async (_id: string, params: { command: string; title: string; successExitCodes?: number[] }) =>
      taskToolResponse(await operations.task!.start(params.command, params.title, params.successExitCodes)),
  });
  const taskGet = withIrisToolCallContext({
    name: 'task_get',
    label: 'Get task',
    description: 'Read an immediate task snapshot and a bounded tail of its log.',
    parameters: Type.Object({
      taskId: Type.String(),
      cursor: Type.Optional(Type.String()),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 * 1024 })),
    }),
    execute: async (_id: string, params: { taskId: string; cursor?: string; maxBytes?: number }) =>
      taskToolResponse(await operations.task!.get(params.taskId, params.cursor, params.maxBytes)),
  });
  const taskList = withIrisToolCallContext({
    name: 'task_list',
    label: 'List tasks',
    description: 'List background task summaries without loading their complete logs.',
    parameters: Type.Object({
      scope: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('all')])),
      cursor: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    execute: async (_id: string, params: { scope?: 'active' | 'all'; cursor?: string; limit?: number }) =>
      taskToolResponse(await operations.task!.list(params.scope, params.cursor, params.limit)),
  });
  const taskCancel = withIrisToolCallContext({
    name: 'task_cancel',
    label: 'Cancel task',
    description: 'Request cancellation of a background task and return its current snapshot.',
    parameters: Type.Object({ taskId: Type.String() }),
    execute: async (_id: string, params: { taskId: string }) =>
      taskToolResponse(await operations.task!.cancel(params.taskId)),
  });
  return [
    withIrisToolCallContext(fileTool('read', Type.Object({
      path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
      offset: Type.Optional(Type.Number({ description: '1-indexed line number to start reading from' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
    }), async (_id, params) => {
      await operations.read.access(join(cwd, params.path));
      const readOptions = {
        ...(params.offset === undefined ? {} : { offset: params.offset }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      };
      const media = await operations.read.readMediaFile(
        join(cwd, params.path),
        Object.keys(readOptions).length > 0 ? readOptions : undefined,
      );
      if (media.kind === 'image') {
        return {
          content: [
            { type: 'text' as const, text: renderReadImageSummary(params.path, media) },
            { type: 'image' as const, data: media.dataBase64, mimeType: media.mimeType },
          ],
          details: {},
        };
      }
      return { content: [{ type: 'text' as const, text: media.text }], details: {} };
    })),
    withIrisToolCallContext(fileTool('edit', Type.Object({
      path: Type.String(),
      edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }),
    }), async (_id, params) => {
      await operations.edit.writeFile(join(cwd, params.path), params.edits);
      return {
        content: [{ type: 'text' as const, text: `Successfully replaced ${params.edits.length} block(s) in ${params.path}.` }],
        details: {},
      };
    })),
    withIrisToolCallContext(fileTool('write', Type.Object({
      path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
      content: Type.String({ description: 'Content to write to the file' }),
    }), async (_id, params) => {
      await operations.write.writeFile(join(cwd, params.path), params.content);
      return { content: [{ type: 'text' as const, text: `Successfully wrote ${Buffer.byteLength(params.content, 'utf8')} bytes to ${params.path}` }], details: {} };
    })),
    withIrisToolCallContext(terminal),
    ...(operations.task ? [taskStart, taskGet, taskList, taskCancel] : []),
  ] as const;
}

function taskToolResponse(result: AgentToolOperationResult): { content: Array<{ type: 'text'; text: string }>; details: AgentToolOperationResult } {
  return {
    content: [{ type: 'text', text: result.kind === 'task' ? result.outputText : JSON.stringify(result) }],
    details: result,
  };
}

interface IrisModelRuntime {
  setProvider(provider: Provider): void;
  getProvider(providerId: string): Provider | undefined;
  getModels(providerId?: string): readonly Model<Api>[];
  getModel(providerId: string, modelId: string): Model<Api> | undefined;
  getError(): string | undefined;
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
}

function credentialStore(path: string) {
  return {
    async read(providerId: string) {
      return (await readCredentialFile(path))[providerId];
    },
    async list() {
      return Object.keys(await readCredentialFile(path)).map((providerId) => ({ providerId, type: 'api_key' as const }));
    },
    async modify(providerId: string, fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>) {
      const current = await readCredentialFile(path);
      const next = await fn(current[providerId]);
      if (next) current[providerId] = next;
      else delete current[providerId];
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, JSON.stringify(current, null, 2) + '\n', 'utf8');
      return next;
    },
    async delete(providerId: string) {
      const current = await readCredentialFile(path);
      delete current[providerId];
      await fs.writeFile(path, JSON.stringify(current, null, 2) + '\n', 'utf8');
    },
  };
}

/**
 * Pi is used here as an API transport and model-metadata library only. Its
 * builtin providers are registered so a configured Iris provider profile can
 * borrow the matching API implementation and model metadata, but they are never
 * a model source: the user-facing model list is owned entirely by Iris provider
 * profiles.
 */
function createIrisRuntime(agentDir: string): IrisModelRuntime {
  const models = createModels({ credentials: credentialStore(join(agentDir, 'auth.json')) });
  for (const provider of builtinProviders()) models.setProvider(provider);
  return {
    setProvider: (provider) => models.setProvider(provider),
    getProvider: (providerId) => models.getProvider(providerId),
    getModels: (providerId) => models.getModels(providerId),
    getModel: (providerId, modelId) => models.getModel(providerId, modelId),
    getError: () => undefined,
    streamSimple: (model, context, options) => models.streamSimple(model, context, options),
    completeSimple: (model, context, options) => models.completeSimple(model, context, options),
  };
}

function fileTool(name: string, parameters: unknown, execute: (id: string, params: any) => Promise<unknown>): any {
  return { name, label: name, description: `${name} a file`, parameters, execute };
}

function withIrisToolCallContext<T extends { execute: (...args: any[]) => any }>(tool: T): T {
  return {
    ...tool,
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: unknown) =>
      irisToolCallContext.run(
        toolCallId,
        () => tool.execute(toolCallId, params, signal, onUpdate, context),
      ),
  };
}

export async function loadIrisModelCatalog(
  agentDir: string,
  profileRoot: string,
  discoverRemote = false,
): Promise<IrisAgentModelCatalog> {
  try {
    const profileErrors: string[] = [];
    const runtime = await createIrisModelRuntime(agentDir, profileRoot, {
      kind: 'discover',
      discoverRemote,
      onError: (profileName, error) => {
        profileErrors.push(`${profileName}: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    const profiles = await loadProviderProfiles(profileRoot);
    const profileNames = new Map(
      profiles.map((profile) => [runtimeProviderId(profile.id), profile.name]),
    );
    const configuredModels = new Map<string, IrisAgentConfiguredModel>();
    for (const profile of profiles) {
      const providerId = runtimeProviderId(profile.id);
      for (const model of profile.models) {
        configuredModels.set(modelKey(providerId, model.modelId), model);
      }
    }
    // Iris owns the model list: only models of configured provider profiles are
    // exposed. Pi's builtin catalog is metadata for those profiles, never a
    // source of selectable models.
    const models = profiles
      .flatMap((profile) => {
        const providerId = runtimeProviderId(profile.id);
        return runtime.getModels(providerId).map((model) => toIrisModelOption(
          model,
          profileNames.get(providerId),
          configuredModels.get(modelKey(providerId, model.id)),
        ));
      })
      .sort(compareModels);
    const runtimeError = runtime.getError();
    const errors = [runtimeError, ...profileErrors].filter((error): error is string => !!error);
    return { models, ...(errors.length > 0 ? { error: errors.join('\n') } : {}) };
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadIrisProviderCatalog(
  profileRoot: string,
  agentDir?: string,
): Promise<IrisAgentProviderCatalog> {
  try {
    const profiles = await loadProviderProfiles(profileRoot);
    const modelCatalog = agentDir
      ? await loadIrisModelCatalog(agentDir, profileRoot, false)
      : { models: [] };
    return {
      templates: [...IRIS_AGENT_PROVIDER_TEMPLATES],
      profiles: profilesForRenderer(profiles).map((profile) => ({
        ...profile,
        models: (profile.models ?? []).map((model) => {
          return {
            ...model,
            ...(model.customParameters ? { customParameters: model.customParameters } : {}),
          };
        }),
      })),
      ...(modelCatalog.error ? { error: modelCatalog.error } : {}),
    };
  } catch (error) {
    const profiles = await loadProviderProfiles(profileRoot).catch(() => []);
    return {
      templates: [...IRIS_AGENT_PROVIDER_TEMPLATES],
      profiles: profilesForRenderer(profiles),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The provider-facing content of the request being sent.
 *
 * The request is one turn, so its images belong on the same user message as the
 * assembled prompt rather than on a second message the provider would have to
 * correlate. A text-only request keeps the plain string form, which is what
 * every existing provider path already expects.
 */
export function renderPromptContent(
  prompt: string,
  images?: readonly AgentPromptImage[],
): string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  if (!images?.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...images.map((image) => ({
      type: 'image' as const,
      data: image.dataBase64,
      mimeType: image.attachment.mimeType,
    })),
  ];
}

export async function createIrisPiSession(options: {
    cwd: string;
    agentDir: string;
    providerProfileRoot: string;
    operations: IrisToolHostOperations;
    history: AgentHistorySnapshot;
    model: IrisAgentModelRef;
    commandShell: AgentCommandShell;
    providerProxy: AgentProviderProxy;
    customParameters?: Record<string, unknown>;
    enabledTools?: string[];
    systemPrompt?: string;
    executeToolCall?: (toolCall: ToolCall) => Promise<ToolResultMessage>;
    onProviderPayload?: (
      payload: unknown,
      model: { provider: string; id: string; api: string },
    ) => void | Promise<void>;
    onProviderFailure?: (
      failure: string | null,
      model: { provider: string; id: string; api: string },
    ) => void | Promise<void>;
}) {
  const { agentDir, providerProfileRoot, model: modelRef, providerProxy, onProviderPayload, onProviderFailure } = options;
  const modelRuntime = await createIrisModelRuntime(agentDir, providerProfileRoot, {
    kind: 'selected',
    model: modelRef,
  });
  const model = modelRuntime.getModel(modelRef.provider, modelRef.modelId);
  if (!model) {
    throw new Error(
      `Configured Iris Agent model was not found: ${modelRef.provider}/${modelRef.modelId}`,
    );
  }
  if (!model.input?.length) {
    throw new Error(
      `Model input capability is not configured: ${modelRef.provider}/${modelRef.modelId}. Configure text/image input explicitly before use.`,
    );
  }
  const transport = createProviderTransport(providerProxy);
  const streamRuntime = instrumentProviderPayloads(modelRuntime, onProviderPayload, onProviderFailure, transport.fetch);
  const messages = options.history.messages.map((item) => toPiHistoryMessage(item, model));
  const listeners = new Set<(event: unknown) => void | Promise<void>>();
  let aborted = false;
  let activeAbortController: AbortController | null = null;
  const state = { messages };
  const emit = async (event: unknown) => {
    for (const listener of listeners) await listener(event);
  };
  const enabled = new Set(options.enabledTools ?? [...enabledJtpToolIds()]);
  const tools = createIrisPiToolDefinitions(options.cwd, options.operations, options.commandShell)
    .filter((tool) => enabled.has(tool.name))
    .map((tool) => {
      const descriptor = JTP_BUILTIN_TOOLS.find((item) => item.id === tool.name);
      return { name: tool.name, description: descriptor?.description ?? tool.description, parameters: descriptor?.input ?? tool.parameters };
    }) as Tool[];
  const execute = async (input?: string, images?: readonly AgentPromptImage[]) => {
    if (input !== undefined) {
      state.messages.push({
        role: 'user',
        content: renderPromptContent(input, images),
        timestamp: Date.now(),
      });
    }
    while (!aborted) {
      activeAbortController = new AbortController();
      const context: Context = { systemPrompt: options.systemPrompt ?? IRIS_AGENT_PROMPT, messages: state.messages, tools };
      const stream = streamRuntime.streamSimple(model, context, {
        signal: activeAbortController.signal,
        ...(options.customParameters ? {
          onPayload: (payload: unknown) => {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
            return { ...(payload as Record<string, unknown>), ...options.customParameters };
          },
        } : {}),
      });
      let final: AssistantMessage | undefined;
      for await (const event of stream) {
        if (event.type === 'text_start' || event.type === 'text_delta' ||
          event.type === 'thinking_start' || event.type === 'thinking_delta' ||
          event.type === 'toolcall_start' || event.type === 'toolcall_delta') {
          await emit({ type: 'message_update', assistantMessageEvent: event, message: event.partial });
        }
        if (event.type === 'done') final = event.message;
        if (event.type === 'error') final = event.error;
      }
      const response = final ?? await stream.result();
      state.messages.push(response);
      await emit({ type: 'message_end', message: response });
      if (response.stopReason === 'error' || response.stopReason === 'aborted' || response.content.every((part) => part.type !== 'toolCall')) break;
      const calls = response.content.flatMap((part) => part.type === 'toolCall' ? [part] : []);
      for (const call of calls) {
        if (aborted) break;
        const result = options.executeToolCall
          ? await irisToolCallContext.run(call.id, () => options.executeToolCall!(call))
          : { role: 'toolResult' as const, toolCallId: call.id, toolName: call.name, content: [{ type: 'text' as const, text: 'Tool execution is unavailable.' }], isError: true, timestamp: Date.now() };
        state.messages.push(result);
        await emit({ type: 'message_end', message: result });
      }
      activeAbortController = null;
    }
    activeAbortController = null;
    await emit({ type: 'agent_end', messages: state.messages });
  };
  return {
    session: {
      agent: { state, continue: () => execute() },
      subscribe(listener: (event: unknown) => void | Promise<void>) { listeners.add(listener); return () => listeners.delete(listener); },
      prompt: (input: string, images?: readonly AgentPromptImage[]) => execute(input, images),
      continue: () => execute(),
      abort: async () => { aborted = true; activeAbortController?.abort(); },
      dispose: () => { aborted = true; listeners.clear(); },
    },
    modelRuntime,
    model,
    disposeProviderTransport: transport.dispose,
  };
}

/**
 * Runs a single provider call that summarizes Session history for compaction.
 *
 * This is deliberately not an Agent execution: it has no tools, no Pi Session, and
 * never appends to any conversation history, so it cannot contribute Trace facts.
 * The caller owns the resulting text and decides whether to persist it.
 */
export async function summarizeIrisAgentHistory(options: {
  agentDir: string;
  providerProfileRoot: string;
  model: IrisAgentModelRef;
  instruction: string;
  material: string;
  providerProxy: AgentProviderProxy;
  signal?: AbortSignal;
}): Promise<string> {
  const modelRuntime = await createIrisModelRuntime(options.agentDir, options.providerProfileRoot, {
    kind: 'selected',
    model: options.model,
  });
  const model = modelRuntime.getModel(options.model.provider, options.model.modelId);
  if (!model) {
    throw new Error(
      `Configured Iris Agent model was not found: ${options.model.provider}/${options.model.modelId}`,
    );
  }
  const transport = createProviderTransport(options.providerProxy);
  try {
    const response = await modelRuntime.completeSimple(model, {
      systemPrompt: options.instruction,
      tools: [],
      messages: [{ role: 'user', content: options.material, timestamp: Date.now() }],
    }, {
      ...(transport.fetch ? { fetch: transport.fetch } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.content
      .flatMap((part) => part.type === 'text' ? [part.text] : [])
      .join('\n')
      .trim();
  } finally {
    await transport.dispose();
  }
}

export async function resolveIrisModelBaseUrl(
  profileRoot: string,
  modelRef: IrisAgentModelRef,
): Promise<string> {
  const profiles = await loadProviderProfiles(profileRoot);
  const profile = profiles.find((candidate) => runtimeProviderId(candidate.id) === modelRef.provider);
  if (!profile) {
    throw new Error(
      `Configured Iris Agent model is not provided by an Iris provider profile: ${modelRef.provider}/${modelRef.modelId}`,
    );
  }
  const template = findIrisAgentProviderTemplate(profile.templateId);
  if (!template) throw new Error(`Configured Iris Agent provider template was not found: ${profile.templateId}`);
  return profile.baseUrl || template.defaultBaseUrl;
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

type IrisProfileModelMode =
  | { kind: 'none' }
  | {
      kind: 'discover';
      discoverRemote: boolean;
      onError?: (profileName: string, error: unknown) => void;
    }
  | { kind: 'selected'; model: IrisAgentModelRef };

async function createIrisModelRuntime(
  agentDir: string,
  profileRoot: string,
  profileMode: IrisProfileModelMode = { kind: 'discover', discoverRemote: true },
): Promise<IrisModelRuntime> {
  const runtime = createIrisRuntime(agentDir);
  const profiles = await loadProviderProfiles(profileRoot);
  if (profileMode.kind === 'none') return runtime;
  if (profileMode.kind === 'discover') {
    const discoveries = await Promise.all(profiles.map(async (profile) => {
      const template = findIrisAgentProviderTemplate(profile.templateId);
      if (!template) return null;
      const baseUrl = profile.baseUrl || template.defaultBaseUrl;
      try {
        return {
          profile,
          providerId: runtimeProviderId(profile.id),
          template,
          baseUrl,
          modelIds: profileMode.discoverRemote
            ? await fetchIrisProviderModelIds(template, baseUrl, profile.apiKey)
            : profile.models.filter((model) => model.enabled).map((model) => model.modelId),
        };
      } catch (error) {
        profileMode.onError?.(profile.name, error);
        return null;
      }
    }));
    for (const discovery of discoveries) {
      if (!discovery) continue;
      registerProfileProvider(runtime, discovery.providerId, discovery.profile.name, discovery.template,
        discovery.baseUrl, discovery.profile.apiKey, discovery.modelIds, discovery.profile.models);
    }
    return runtime;
  }
  let registered = false;
  for (const profile of profiles) {
    const providerId = runtimeProviderId(profile.id);
    if (providerId !== profileMode.model.provider) continue;
    const template = findIrisAgentProviderTemplate(profile.templateId);
    if (!template) continue;
    const baseUrl = profile.baseUrl || template.defaultBaseUrl;
    registerProfileProvider(runtime, providerId, profile.name, template, baseUrl, profile.apiKey,
      [profileMode.model.modelId], profile.models);
    registered = true;
  }
  if (!registered) {
    // A model whose provider is not one of our profiles must never fall through
    // to a Pi builtin provider.
    throw new Error(
      `Configured Iris Agent model is not provided by an Iris provider profile: ${profileMode.model.provider}/${profileMode.model.modelId}`,
    );
  }
  return runtime;
}

export async function createIrisModelRuntimeForTest(agentDir: string, profileRoot: string): Promise<IrisModelRuntime> {
  return createIrisModelRuntime(agentDir, profileRoot, { kind: 'none' });
}

function registerProfileProvider(
  runtime: IrisModelRuntime,
  providerId: string,
  name: string,
  template: typeof IRIS_AGENT_PROVIDER_TEMPLATES[number],
  baseUrl: string,
  apiKey: string,
  modelIds: readonly string[],
  configuredModels: readonly IrisAgentConfiguredModel[],
): void {
  const source = runtime.getProvider(template.sourceProvider);
  if (!source) throw new Error(`Built-in provider is unavailable: ${template.sourceProvider}`);
  const models = profileModelsConfig(runtime.getModels(template.sourceProvider), template.api, modelIds, configuredModels)
    .map((model) => ({ ...model, provider: providerId, baseUrl: baseUrl || source.baseUrl || '' }));
  const provider = createProvider({
    id: providerId,
    name,
    ...(baseUrl ? { baseUrl } : {}),
    auth: {
      apiKey: {
        name: `${name} API key`,
        resolve: async () => ({ auth: { apiKey }, source: name }),
        login: async (interaction) => ({ type: 'api_key' as const, key: await interaction.prompt({ type: 'secret', message: `${name} API key` }) }),
      },
    },
    models,
    api: {
      stream: source.stream.bind(source),
      streamSimple: source.streamSimple.bind(source),
    },
  });
  runtime.setProvider(provider);
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    response = await fetch(endpoint, { headers, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Could not load models for ${template.name}: request timed out after 1 second.`);
    }
    throw new Error(`Could not load models for ${template.name}: ${renderRawError(error)}`);
  } finally {
    clearTimeout(timeout);
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

export function toIrisModelOption(model: {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input?: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Partial<Record<'off' | IrisAgentThinkingLevel, string | null>>;
  compat?: unknown;
}, providerName?: string, configured?: IrisAgentConfiguredModel): IrisAgentModelOption {
  return {
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    ...(configured?.customParameters ? { customParameters: configured.customParameters } : {}),
    // The composer gates its attach control on explicit model capability data.
    capabilities: {
      input: (configured?.input ?? model.input)?.includes('image')
        ? ['text', 'image']
        : (configured?.input ?? model.input)?.length ? ['text'] : [],
    },
    ...(model.contextWindow ? { contextWindowTokens: model.contextWindow } : {}),
    ...(model.maxTokens ? { maxOutputTokens: model.maxTokens } : {}),
    ...(providerName ? { providerName } : {}),
    ...(configured
      ? {
          contextPolicy: {
            reserveOutputTokens: configured.reserveOutputTokens,
            keepRecentTokens: configured.keepRecentTokens,
            compactTrigger: configured.compactTrigger,
          },
          source: configured.source,
          enabled: configured.enabled,
        }
      : {}),
  };
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}\0${modelId}`;
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
  sessionManager: IrisHistoryManager,
  history: AgentHistorySnapshot,
): void {
  for (const item of history.messages) {
    sessionManager.appendMessage(toPiHistoryMessage(item));
  }
}

export class IrisHistoryManager {
  readonly messages: Message[] = [];
  appendMessage(message: Message): void { this.messages.push(message); }
  buildSessionContext(): Context { return { messages: [...this.messages] }; }
}

export function instrumentProviderPayloads(
  modelRuntime: IrisModelRuntime,
  capture?: (
    payload: unknown,
    model: { provider: string; id: string; api: string },
  ) => void | Promise<void>,
  captureFailure?: (
    failure: string | null,
    model: { provider: string; id: string; api: string },
  ) => void | Promise<void>,
  providerFetch?: typeof globalThis.fetch,
): IrisModelRuntime {
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
  }) as IrisModelRuntime['streamSimple'];
  return modelRuntime;
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

type IrisPiContext = Context;
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
  currentModel?: Model<Api>,
): Message {
  if (item.role === 'assistant') {
    if (item.providerReplay && currentModel &&
      item.providerReplay.api === currentModel.api &&
      item.providerReplay.provider === currentModel.provider &&
      item.providerReplay.model === currentModel.id) {
      const replay = structuredClone(item.providerReplay.message) as unknown as AssistantMessage;
      if (isPiMessage(replay) && replay.role === 'assistant') return replay;
    }
    const content = [
      ...(typeof item.content === 'string' && item.content
        ? [{ type: 'text' as const, text: item.content }]
        : []),
      ...(item.toolCalls ?? []).map((call) => ({
        type: 'toolCall' as const,
        id: call.id,
        name: call.tool,
        arguments: call.input,
      })),
    ];
    return {
      role: 'assistant',
      content,
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
      stopReason: item.toolCalls?.length ? 'toolUse' : 'stop',
      timestamp: item.createdAt,
    } as AssistantMessage;
  }
  if (item.role === 'tool' && item.toolCallId && item.tool) {
    if (!Array.isArray(item.content)) {
      throw new Error(
        `Invalid tool history content for ${item.toolCallId}: expected an array of content blocks, got ${typeof item.content}.`,
      );
    }
    return {
      role: 'toolResult',
      toolCallId: item.toolCallId,
      toolName: item.tool,
      content: toPiToolResultContent(item.content),
      isError: item.isError ?? false,
      timestamp: item.createdAt,
    } as ToolResultMessage;
  }
  return {
    role: 'user',
    content: toPiContent(item.content),
    timestamp: item.createdAt,
  };
}

/**
 * History content already carries hydrated image bytes for a tool result, so a
 * resumed Session sends the same pictures the original request did instead of
 * a text placeholder.
 */
function toPiContent(
  content: AgentHistorySnapshot['messages'][number]['content'],
): string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  if (typeof content === 'string') return content;
  return content.map((part) => part.type === 'text'
    ? { type: 'text' as const, text: part.text }
    : { type: 'image' as const, data: part.dataBase64, mimeType: part.attachment.mimeType });
}

function toPiToolResultContent(
  content: Exclude<AgentHistorySnapshot['messages'][number]['content'], string>,
): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  return content.map((part) => part.type === 'text'
    ? { type: 'text' as const, text: part.text }
    : { type: 'image' as const, data: part.dataBase64, mimeType: part.attachment.mimeType });
}

function isPiMessage(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const role = (value as Record<string, unknown>).role;
  return role === 'user' || role === 'assistant' || role === 'toolResult';
}
