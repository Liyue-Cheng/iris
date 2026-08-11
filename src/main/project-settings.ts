import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { LUCIDE_ICON_NAMES } from '@shared/lucide-icon-names';
import type {
  ProjectSettings,
  ProjectSettingsSnapshot,
  ProjectToolbarAction,
} from '@shared/types';
import { FOREIGN_AGENT_ENTRIES } from './iris-templates';
import { writeFileAtomic } from './atomic-write';

export const PROJECT_SETTINGS_RELATIVE_PATH = '.iris/settings.json';
export const MISSING_PROJECT_SETTINGS_REVISION = 'missing';
export const MAX_PROJECT_TOOLBAR_ACTIONS = 32;
export const MAX_PROJECT_ICON_LENGTH = 80;
export const MAX_PROJECT_DESCRIPTION_LENGTH = 160;
export const MAX_PROJECT_COMMAND_LENGTH = 4096;
export const MAX_PROJECT_SETTINGS_BYTES = 1024 * 1024;
export const SUPPORTED_PROJECT_ENTRY_PATHS: readonly string[] = [
  'AGENTS.md',
  ...FOREIGN_AGENT_ENTRIES,
];

const lucideIconNames = new Set<string>(LUCIDE_ICON_NAMES);

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  version: 1,
  prompts: { project: '' },
  agentContext: { entries: ['AGENTS.md'] },
  toolbar: { actions: [] },
};

export class ProjectSettingsError extends Error {
  constructor(
    public readonly code: 'InvalidSettings' | 'WriteConflict' | 'ReadFailed' | 'WriteFailed',
    message: string,
  ) {
    super(`[ProjectSettings] ${code}: ${message}`);
    this.name = 'ProjectSettingsError';
  }
}

interface FileRead {
  text: string | null;
  revision: string;
  error: string | null;
}

function settingsPath(root: string): string {
  return join(root, PROJECT_SETTINGS_RELATIVE_PATH);
}

function revisionFor(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function readFile(root: string): Promise<FileRead> {
  try {
    const path = settingsPath(root);
    const stat = await fs.stat(path);
    if (stat.size > MAX_PROJECT_SETTINGS_BYTES) {
      return {
        text: null,
        revision: MISSING_PROJECT_SETTINGS_REVISION,
        error: `Project settings exceeds the ${MAX_PROJECT_SETTINGS_BYTES}-byte limit`,
      };
    }
    const text = await fs.readFile(path, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_PROJECT_SETTINGS_BYTES) {
      return {
        text: null,
        revision: MISSING_PROJECT_SETTINGS_REVISION,
        error: `Project settings exceeds the ${MAX_PROJECT_SETTINGS_BYTES}-byte limit`,
      };
    }
    return { text, revision: revisionFor(text), error: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { text: null, revision: MISSING_PROJECT_SETTINGS_REVISION, error: null };
    }
    return {
      text: null,
      revision: MISSING_PROJECT_SETTINGS_REVISION,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAction(value: unknown, index: number): {
  action: ProjectToolbarAction | null;
  diagnostic: string | null;
} {
  if (!isRecord(value)) {
    return { action: null, diagnostic: `toolbar.actions[${index}] must be an object` };
  }
  const icon = typeof value.icon === 'string' ? value.icon.trim() : '';
  const description = typeof value.description === 'string' ? value.description.trim() : '';
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const terminal = value.terminal;
  if (
    !icon ||
    icon.length > MAX_PROJECT_ICON_LENGTH ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(icon) ||
    !lucideIconNames.has(icon)
  ) {
    return {
      action: null,
      diagnostic: `toolbar.actions[${index}].icon must name an available Lucide icon`,
    };
  }
  if (!description || description.length > MAX_PROJECT_DESCRIPTION_LENGTH) {
    return {
      action: null,
      diagnostic: `toolbar.actions[${index}].description must be 1-${MAX_PROJECT_DESCRIPTION_LENGTH} characters`,
    };
  }
  if (!command || command.length > MAX_PROJECT_COMMAND_LENGTH) {
    return {
      action: null,
      diagnostic: `toolbar.actions[${index}].command must be 1-${MAX_PROJECT_COMMAND_LENGTH} characters`,
    };
  }
  if (terminal !== 'iris' && terminal !== 'system') {
    return {
      action: null,
      diagnostic: `toolbar.actions[${index}].terminal must be iris or system`,
    };
  }
  return { action: { icon, description, command, terminal }, diagnostic: null };
}

function parseSettings(text: string): {
  settings: ProjectSettings;
  diagnostics: string[];
  error: string | null;
  raw: Record<string, unknown> | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      diagnostics: [],
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw: null,
    };
  }
  if (!isRecord(parsed)) {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      diagnostics: [],
      error: 'The project settings root must be an object',
      raw: null,
    };
  }
  if (parsed.version !== 1) {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      diagnostics: [],
      error: `Unsupported project settings version: ${String(parsed.version)}`,
      raw: parsed,
    };
  }
  const prompts = parsed.prompts;
  if (prompts !== undefined && !isRecord(prompts)) {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      diagnostics: [],
      error: 'prompts must be an object',
      raw: parsed,
    };
  }
  const projectPrompt = isRecord(prompts) ? prompts.project : undefined;
  if (projectPrompt !== undefined && typeof projectPrompt !== 'string') {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      diagnostics: [],
      error: 'prompts.project must be a string',
      raw: parsed,
    };
  }
  const agentContext = parsed.agentContext;
  if (agentContext !== undefined && !isRecord(agentContext)) {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      diagnostics: [],
      error: 'agentContext must be an object',
      raw: parsed,
    };
  }
  const rawEntries = isRecord(agentContext) ? agentContext.entries : undefined;
  if (
    rawEntries !== undefined &&
    (!Array.isArray(rawEntries) || rawEntries.some((entry) => typeof entry !== 'string'))
  ) {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      diagnostics: [],
      error: 'agentContext.entries must be a string[]',
      raw: parsed,
    };
  }
  const entries = rawEntries === undefined ? ['AGENTS.md'] : [...new Set(rawEntries)];
  if (!entries.includes('AGENTS.md')) {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      diagnostics: [],
      error: 'agentContext.entries must include AGENTS.md',
      raw: parsed,
    };
  }
  const unsupportedEntry = entries.find(
    (entry) => !SUPPORTED_PROJECT_ENTRY_PATHS.includes(entry),
  );
  if (unsupportedEntry) {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      diagnostics: [],
      error: `Unsupported agent context entry: ${unsupportedEntry}`,
      raw: parsed,
    };
  }
  const toolbar = parsed.toolbar;
  if (toolbar !== undefined && !isRecord(toolbar)) {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      diagnostics: [],
      error: 'toolbar must be an object',
      raw: parsed,
    };
  }
  const rawActions = isRecord(toolbar) ? toolbar.actions : undefined;
  if (rawActions !== undefined && !Array.isArray(rawActions)) {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      diagnostics: [],
      error: 'toolbar.actions must be an array',
      raw: parsed,
    };
  }
  const diagnostics: string[] = [];
  const actions: ProjectToolbarAction[] = [];
  for (const [index, value] of (rawActions ?? []).entries()) {
    if (index >= MAX_PROJECT_TOOLBAR_ACTIONS) {
      diagnostics.push(`toolbar.actions is limited to ${MAX_PROJECT_TOOLBAR_ACTIONS} entries`);
      break;
    }
    const normalized = normalizeAction(value, index);
    if (normalized.action) actions.push(normalized.action);
    if (normalized.diagnostic) diagnostics.push(normalized.diagnostic);
  }
  return {
    settings: {
      version: 1,
      prompts: { project: projectPrompt ?? '' },
      agentContext: { entries },
      toolbar: { actions },
    },
    diagnostics,
    error: null,
    raw: parsed,
  };
}

export type ProjectSettingsFileSnapshot = Omit<ProjectSettingsSnapshot, 'trusted'> & {
  entryListExplicit: boolean;
};

export async function readProjectSettings(root: string): Promise<ProjectSettingsFileSnapshot> {
  const file = await readFile(root);
  if (file.error) {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      revision: file.revision,
      exists: false,
      diagnostics: [],
      error: file.error,
      entryListExplicit: false,
    };
  }
  if (file.text === null) {
    return {
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      revision: MISSING_PROJECT_SETTINGS_REVISION,
      exists: false,
      diagnostics: [],
      error: null,
      entryListExplicit: false,
    };
  }
  const parsed = parseSettings(file.text);
  return {
    settings: parsed.settings,
    revision: file.revision,
    exists: true,
    diagnostics: parsed.diagnostics,
    error: parsed.error,
    entryListExplicit:
      !!parsed.raw &&
      isRecord(parsed.raw.agentContext) &&
      Array.isArray(parsed.raw.agentContext.entries),
  };
}

export async function updateProjectToolbar(
  root: string,
  actions: readonly ProjectToolbarAction[],
  expectedRevision: string,
): Promise<ProjectSettingsFileSnapshot> {
  if (!Array.isArray(actions) || actions.length > MAX_PROJECT_TOOLBAR_ACTIONS) {
    throw new ProjectSettingsError(
      'InvalidSettings',
      `toolbar.actions must contain at most ${MAX_PROJECT_TOOLBAR_ACTIONS} entries`,
    );
  }
  const normalizedActions = actions.map((action, index) => {
    const normalized = normalizeAction(action, index);
    if (!normalized.action) {
      throw new ProjectSettingsError('InvalidSettings', normalized.diagnostic ?? 'Invalid action');
    }
    return normalized.action;
  });

  return updateProjectSettings(root, expectedRevision, (raw) => {
    const previousToolbar = isRecord(raw.toolbar) ? raw.toolbar : {};
    return {
      ...raw,
      version: 1,
      prompts: isRecord(raw.prompts) ? raw.prompts : { project: '' },
      agentContext: isRecord(raw.agentContext)
        ? raw.agentContext
        : structuredClone(DEFAULT_PROJECT_SETTINGS.agentContext),
      toolbar: { ...previousToolbar, actions: normalizedActions },
    };
  });
}

export async function updateProjectPrompt(
  root: string,
  project: string,
  expectedRevision: string,
): Promise<ProjectSettingsFileSnapshot> {
  if (typeof project !== 'string') {
    throw new ProjectSettingsError('InvalidSettings', 'prompts.project must be a string');
  }
  return updateProjectSettings(root, expectedRevision, (raw) => {
    const previousPrompts = isRecord(raw.prompts) ? raw.prompts : {};
    return {
      ...raw,
      version: 1,
      prompts: { ...previousPrompts, project },
      agentContext: isRecord(raw.agentContext)
        ? raw.agentContext
        : structuredClone(DEFAULT_PROJECT_SETTINGS.agentContext),
      toolbar: isRecord(raw.toolbar) ? raw.toolbar : { actions: [] },
    };
  });
}

export async function updateProjectEntries(
  root: string,
  entries: readonly string[],
  expectedRevision: string,
): Promise<ProjectSettingsFileSnapshot> {
  const normalized = [...new Set(entries)];
  if (!normalized.includes('AGENTS.md')) {
    throw new ProjectSettingsError(
      'InvalidSettings',
      'agentContext.entries must include AGENTS.md',
    );
  }
  const unsupported = normalized.find(
    (entry) => !SUPPORTED_PROJECT_ENTRY_PATHS.includes(entry),
  );
  if (unsupported) {
    throw new ProjectSettingsError(
      'InvalidSettings',
      `Unsupported agent context entry: ${unsupported}`,
    );
  }
  return updateProjectSettings(root, expectedRevision, (raw) => ({
    ...raw,
    version: 1,
    prompts: isRecord(raw.prompts) ? raw.prompts : { project: '' },
    agentContext: { entries: normalized },
    toolbar: isRecord(raw.toolbar) ? raw.toolbar : { actions: [] },
  }));
}

export async function initializeProjectSettingsFile(
  root: string,
  project: string,
  entries: readonly string[],
  expectedRevision: string,
): Promise<ProjectSettingsFileSnapshot> {
  const initialized = await updateProjectEntries(root, entries, expectedRevision);
  if (initialized.settings.prompts.project === project) return initialized;
  return updateProjectPrompt(root, project, initialized.revision);
}

async function updateProjectSettings(
  root: string,
  expectedRevision: string,
  mutate: (raw: Record<string, unknown>) => Record<string, unknown>,
): Promise<ProjectSettingsFileSnapshot> {
  const file = await readFile(root);
  if (file.error) throw new ProjectSettingsError('ReadFailed', file.error);
  if (file.revision !== expectedRevision) {
    throw new ProjectSettingsError('WriteConflict', 'Project settings changed on disk; reload and retry');
  }

  let raw: Record<string, unknown> = {};
  if (file.text !== null) {
    const parsed = parseSettings(file.text);
    if (parsed.error || !parsed.raw) {
      throw new ProjectSettingsError('InvalidSettings', parsed.error ?? 'Invalid project settings');
    }
    raw = parsed.raw;
  }
  const next = mutate(raw);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const target = settingsPath(root);
  try {
    await writeFileAtomic(target, text);
  } catch (err) {
    throw new ProjectSettingsError(
      'WriteFailed',
      err instanceof Error ? err.message : String(err),
    );
  }
  return readProjectSettings(root);
}
