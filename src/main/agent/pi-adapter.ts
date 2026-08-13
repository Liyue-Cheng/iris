import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  VERSION,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  readStoredCredential,
  type BashOperations,
  type CreateAgentSessionOptions,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent';
import { IRIS_AGENT_PROMPT } from './prompt';

export const IRIS_PI_VERSION = VERSION;
export const IRIS_PI_TOOL_NAMES = ['read', 'edit', 'write', 'terminal'] as const;

export interface IrisToolHostOperations {
  read: ReadOperations;
  edit: EditOperations;
  write: WriteOperations;
  terminal: BashOperations;
}

export function hasStoredPiCredential(providerId: string, authPath?: string): boolean {
  return readStoredCredential(providerId, authPath) !== undefined;
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
    'cwd' | 'resourceLoader' | 'sessionManager' | 'settingsManager' | 'tools' | 'customTools'
  > & {
    cwd: string;
    agentDir: string;
    operations: IrisToolHostOperations;
  },
) {
  const { cwd, agentDir, operations, ...piOptions } = options;
  const resourceLoader = await createIrisPiResourceLoader(cwd, agentDir);
  return createAgentSession({
    ...piOptions,
    cwd,
    agentDir,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    tools: [...IRIS_PI_TOOL_NAMES],
    customTools: createIrisPiToolDefinitions(cwd, operations) as unknown as NonNullable<
      CreateAgentSessionOptions['customTools']
    >,
  });
}
