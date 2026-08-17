import { join } from 'node:path';
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
  type BashOperations,
  type CreateAgentSessionOptions,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent';
import type { AgentHistorySnapshot } from '@shared/agent-protocol';
import { IRIS_AGENT_PROMPT } from './prompt';

export const IRIS_PI_VERSION = VERSION;
export const IRIS_PI_TOOL_NAMES = ['read', 'edit', 'write', 'terminal'] as const;

export function irisPiAgentDir(): string {
  return getAgentDir();
}

export interface IrisToolHostOperations {
  read: ReadOperations;
  edit: EditOperations;
  write: WriteOperations;
  terminal: BashOperations;
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
) {
  const terminal = createBashToolDefinition(cwd, {
    operations: operations.terminal,
    exposeSessionEnvironment: false,
  });
  return [
    createReadToolDefinition(cwd, { operations: operations.read }),
    createEditToolDefinition(cwd, { operations: operations.edit }),
    createWriteToolDefinition(cwd, { operations: operations.write }),
    {
      ...terminal,
      name: 'terminal',
      label: 'Terminal',
      description: terminal.description.replaceAll('bash', 'terminal'),
      promptSnippet: 'Execute a visible command in the current project',
      promptGuidelines: [],
    },
  ] as const;
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
  > & {
    cwd: string;
    agentDir: string;
    operations: IrisToolHostOperations;
    history: AgentHistorySnapshot;
    onProviderPayload?: (
      payload: unknown,
      model: { provider: string; id: string; api: string },
    ) => void | Promise<void>;
  },
) {
  const { cwd, agentDir, operations, history, onProviderPayload, ...piOptions } = options;
  const resourceLoader = await createIrisPiResourceLoader(cwd, agentDir);
  const sessionManager = SessionManager.inMemory(cwd);
  restoreIrisPiHistory(sessionManager, history);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
  });
  instrumentProviderPayloads(modelRuntime, onProviderPayload);
  return createAgentSession({
    ...piOptions,
    cwd,
    agentDir,
    resourceLoader,
    sessionManager,
    modelRuntime,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    tools: [...IRIS_PI_TOOL_NAMES],
    customTools: createIrisPiToolDefinitions(cwd, operations) as unknown as NonNullable<
      CreateAgentSessionOptions['customTools']
    >,
  });
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
): void {
  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = ((model, context, options) =>
    streamSimple(model, normalizeIrisProviderContext(context), {
      ...options,
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
    })) as ModelRuntime['streamSimple'];
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
