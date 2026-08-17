import { randomUUID } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import {
  IRIS_AGENT_PROTOCOL_VERSION,
  agentHistoryDigest,
  isAgentWorkerRequest,
  type AgentCorrelation,
  type AgentToolOperationInput,
  type AgentToolOperationResult,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from '@shared/agent-protocol';
import {
  IRIS_PI_VERSION,
  createIrisPiSession,
  storedPiCredentialSecrets,
  type IrisToolHostOperations,
} from './agent/pi-adapter';
import { collectKnownSecrets, sanitizeProviderPayload } from './agent/context-artifact';

if (!parentPort) throw new Error('Iris Agent Worker requires a worker_threads parent port');
const workerPort = parentPort;

type PendingTool = {
  resolve: (result: AgentToolOperationResult) => void;
  reject: (error: Error) => void;
};

type AgentWorkerEventPayload<T = AgentWorkerEvent> = T extends AgentWorkerEvent
  ? Omit<T, 'version'>
  : never;

let runtime:
  | {
      session: Awaited<ReturnType<typeof createIrisPiSession>>['session'];
      unsubscribe: () => void;
      cwd: string;
      agentDir: string;
    }
  | null = null;
let currentCorrelation: AgentCorrelation = { sessionId: 'unknown' };
let providerCallIndex = 0;
const pendingTools = new Map<string, PendingTool>();

workerPort.on('message', (message: unknown) => {
  void handleMessage(message).catch((err) => {
    post({
      type: 'failure',
      correlation: currentCorrelation,
      code: err instanceof Error ? err.name : 'WorkerError',
      message: err instanceof Error ? err.message : String(err),
    });
    post({ type: 'state', correlation: currentCorrelation, state: 'failed' });
  });
});

async function handleMessage(message: unknown): Promise<void> {
  if (!isAgentWorkerRequest(message)) {
    post({
      type: 'failure',
      correlation: { sessionId: 'unknown' },
      code: 'ProtocolMismatch',
      message: 'Unsupported Iris Agent Worker protocol message',
    });
    return;
  }

  if (message.type === 'initialize') {
    currentCorrelation = message.correlation;
    await initialize(message);
    return;
  }
  if (message.type === 'shutdown') {
    await disposeRuntime();
    post({ type: 'stopped', correlation: message.correlation, reason: 'shutdown' });
    workerPort.close();
    return;
  }
  if (message.type === 'abort') {
    await runtime?.session.abort();
    post({ type: 'state', correlation: message.correlation, state: 'interrupted' });
    return;
  }
  if (message.type === 'tool-result') {
    settleTool(message);
    return;
  }
  if (message.type === 'run') {
    if (!runtime) throw new Error('Iris Agent Worker has not been initialized');
    currentCorrelation = message.correlation;
    providerCallIndex = 0;
    post({ type: 'state', correlation: message.correlation, state: 'running' });
    try {
      await runtime.session.prompt(message.prompt, {
        expandPromptTemplates: false,
        source: 'interactive',
      });
      post({ type: 'state', correlation: message.correlation, state: 'idle' });
    } catch (err) {
      post({
        type: 'failure',
        correlation: message.correlation,
        code: err instanceof Error ? err.name : 'ProviderError',
        message: err instanceof Error ? err.message : String(err),
      });
      post({ type: 'state', correlation: message.correlation, state: 'failed' });
    }
  }
}

async function initialize(message: Extract<AgentWorkerRequest, { type: 'initialize' }>): Promise<void> {
  await disposeRuntime();
  post({ type: 'state', correlation: message.correlation, state: 'starting' });
  const operations = createWorkerOperations();
  const result = await createIrisPiSession({
    cwd: message.runtime.cwd,
    agentDir: message.runtime.agentDir,
    operations,
    history: message.history,
    onProviderPayload: (payload, model) => {
      if (!currentCorrelation.requestId || !currentCorrelation.turnId) return;
      const knownSecrets = collectKnownSecrets([
        storedPiCredentialSecrets(model.provider, message.runtime.agentDir),
        providerSecretEnvironment(),
      ]);
      post({
        type: 'provider-context',
        correlation: currentCorrelation,
        call: {
          index: ++providerCallIndex,
          capturedAt: Date.now(),
          provider: model.provider,
          model: model.id,
          api: model.api,
          payload: sanitizeProviderPayload(payload, knownSecrets),
        },
      });
    },
  });
  const unsubscribe = result.session.subscribe((event) => {
    post({ type: 'stream', correlation: currentCorrelation, event: jsonSafeEvent(event) });
  });
  runtime = {
    session: result.session,
    unsubscribe,
    cwd: message.runtime.cwd,
    agentDir: message.runtime.agentDir,
  };
  post({
    type: 'ready',
    correlation: message.correlation,
    runtime: {
      protocolVersion: IRIS_AGENT_PROTOCOL_VERSION,
      piVersion: IRIS_PI_VERSION,
      nodeVersion: process.versions.node,
      workerEpoch: message.correlation.workerEpoch ?? 0,
      historyRevision: message.history.revision,
      historyMessageCount: result.session.state.messages.length,
      historyDigest: agentHistoryDigest(message.history),
    },
  });
  post({ type: 'state', correlation: message.correlation, state: 'ready' });
}

function providerSecretEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        typeof value === 'string' &&
        /(?:api[_-]?key|token|secret|password|authorization|credential)/iu.test(name),
    ),
  ) as Record<string, string>;
}

function createWorkerOperations(): IrisToolHostOperations {
  return {
    read: {
      access: async (absolutePath) => {
        await requestTool({ tool: 'read', operation: 'access', absolutePath });
      },
      readFile: async (absolutePath) => {
        const result = await requestTool({ tool: 'read', operation: 'readFile', absolutePath });
        if (result.kind !== 'file') throw new Error('Iris Agent readFile returned a non-file result');
        return Buffer.from(result.contentBase64, 'base64');
      },
    },
    edit: {
      access: async (absolutePath) => {
        await requestTool({ tool: 'edit', operation: 'access', absolutePath });
      },
      readFile: async (absolutePath) => {
        const result = await requestTool({ tool: 'edit', operation: 'readFile', absolutePath });
        if (result.kind !== 'file') throw new Error('Iris Agent edit.readFile returned a non-file result');
        return Buffer.from(result.contentBase64, 'base64');
      },
      writeFile: async (absolutePath, content) => {
        await requestTool({ tool: 'edit', operation: 'writeFile', absolutePath, content });
      },
    },
    write: {
      mkdir: async (absolutePath) => {
        await requestTool({ tool: 'write', operation: 'mkdir', absolutePath });
      },
      writeFile: async (absolutePath, content) => {
        await requestTool({ tool: 'write', operation: 'writeFile', absolutePath, content });
      },
    },
    terminal: {
      exec: async (command, cwd, options) => {
        const input: AgentToolOperationInput = {
          tool: 'terminal',
          operation: 'exec',
          command,
          cwd,
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
          ...(options.env === undefined ? {} : { env: options.env }),
        };
        const result = await requestTool(input);
        if (result.kind !== 'terminal') {
          throw new Error('Iris Agent terminal returned a non-terminal result');
        }
        options.onData(Buffer.from(result.outputBase64, 'base64'));
        return { exitCode: result.exitCode };
      },
    },
  };
}

function requestTool(input: AgentToolOperationInput): Promise<AgentToolOperationResult> {
  const toolCallId = randomUUID();
  const correlation: AgentCorrelation = {
    ...currentCorrelation,
    toolCallId,
  };
  post({ type: 'state', correlation, state: 'waiting-tool' });
  workerPort.postMessage({
    version: IRIS_AGENT_PROTOCOL_VERSION,
    type: 'tool-request',
    correlation,
    input,
  } satisfies AgentWorkerEvent);
  return new Promise<AgentToolOperationResult>((resolve, reject) => {
    pendingTools.set(toolCallId, { resolve, reject });
  }).finally(() => {
    post({ type: 'state', correlation: currentCorrelation, state: 'running' });
  });
}

function settleTool(message: Extract<AgentWorkerRequest, { type: 'tool-result' }>): void {
  const toolCallId = message.correlation.toolCallId;
  if (!toolCallId) return;
  const pending = pendingTools.get(toolCallId);
  if (!pending) return;
  pendingTools.delete(toolCallId);
  if (message.ok) pending.resolve(message.result);
  else pending.reject(new Error(message.error));
}

async function disposeRuntime(): Promise<void> {
  for (const [toolCallId, pending] of pendingTools) {
    pendingTools.delete(toolCallId);
    pending.reject(new Error('Iris Agent Worker disposed while a tool call was pending'));
  }
  if (!runtime) return;
  runtime.unsubscribe();
  runtime.session.dispose();
  runtime = null;
}

function post(event: AgentWorkerEventPayload): void {
  workerPort.postMessage({ ...event, version: IRIS_AGENT_PROTOCOL_VERSION } as AgentWorkerEvent);
}

function jsonSafeEvent(event: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(event, (key, value: unknown) => {
        if (key === 'partial') return undefined;
        if (typeof value === 'function') return undefined;
        return value;
      }),
    );
  } catch {
    return {
      type: 'unserializable_event',
      summary: Object.prototype.toString.call(event),
    };
  }
}
