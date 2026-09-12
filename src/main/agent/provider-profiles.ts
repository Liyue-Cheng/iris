import { randomUUID } from 'node:crypto';
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai/compat';
import type {
  IrisAgentConfiguredModel,
  IrisAgentProviderProfileInfo,
  IrisAgentProviderTemplate,
} from '@shared/types';
import { writeFileAtomic } from '../atomic-write';

export const IRIS_AGENT_PROVIDER_TEMPLATES: readonly IrisAgentProviderTemplate[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    sourceProvider: 'openai',
    api: 'openai-responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    sourceProvider: 'anthropic',
    api: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    sourceProvider: 'openai',
    api: 'openai-responses',
    defaultBaseUrl: '',
  },
  {
    id: 'anthropic-compatible',
    name: 'Anthropic Compatible',
    sourceProvider: 'anthropic',
    api: 'anthropic-messages',
    defaultBaseUrl: '',
  },
];

export interface StoredIrisAgentProviderProfile extends Omit<IrisAgentProviderProfileInfo, 'hasCredential'> {
  apiKey: string;
  models: IrisAgentConfiguredModel[];
}

interface ProviderProfileFile {
  version: 1 | 2;
  profiles: StoredIrisAgentProviderProfile[];
}

export function providerProfilesPath(root: string): string {
  return join(root, 'iris-agent-provider-profiles.json');
}

export async function loadStoredIrisAgentProviderProfiles(
  root: string,
): Promise<StoredIrisAgentProviderProfile[]> {
  const loaded = await readProviderProfileFile(providerProfilesPath(root));
  if (!loaded || loaded.version !== 1 || !Array.isArray(loaded.profiles)) {
    return [];
  }
  return loaded.profiles.filter(isStoredProfile).map((profile) => ({
    ...profile,
    models: Array.isArray(profile.models) ? profile.models.map(normalizeConfiguredModel) : [],
  }));
}

export async function addIrisAgentProviderProfile(input: {
  name: string;
  templateId: string;
  baseUrl: string;
  apiKey: string;
}, root: string): Promise<IrisAgentProviderProfileInfo[]> {
  const name = input.name.trim();
  const template = findIrisAgentProviderTemplate(input.templateId);
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();
  if (!name) throw new Error('Provider profile name is required.');
  if (name.length > 200) throw new Error('Provider profile name is too long.');
  if (!template) throw new Error(`Unknown provider template: ${input.templateId}`);
  if (!baseUrl && !template.defaultBaseUrl) {
    throw new Error(`${template.name} requires a Base URL.`);
  }
  if (baseUrl.length > 2_000) throw new Error('Provider Base URL is too long.');
  if (!apiKey) throw new Error('API key is required.');
  if (apiKey.length > 20_000) throw new Error('API key is too long.');
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('Provider Base URL is invalid.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Provider Base URL must start with http:// or https://.');
    }
  }
  const profiles = await loadStoredIrisAgentProviderProfiles(root);
  const profile: StoredIrisAgentProviderProfile = {
    id: randomUUID(),
    name,
    templateId: template.id,
    baseUrl,
    apiKey,
    models: [],
  };
  await writeProviderProfileFile(providerProfilesPath(root), [...profiles, profile]);
  return profilesForRenderer([...profiles, profile]);
}

export async function updateIrisAgentProviderModels(
  profileId: string,
  models: IrisAgentConfiguredModel[],
  root: string,
): Promise<IrisAgentProviderProfileInfo[]> {
  const profiles = await loadStoredIrisAgentProviderProfiles(root);
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error('Provider profile was not found.');
  const normalized = models.map((model) => normalizeConfiguredModel(model));
  await writeProviderProfileFile(providerProfilesPath(root), profiles.map((candidate) =>
    candidate.id === profileId ? { ...candidate, models: normalized } : candidate));
  return profilesForRenderer(profiles.map((candidate) =>
    candidate.id === profileId ? { ...candidate, models: normalized } : candidate));
}

export async function updateIrisAgentProviderProfileApiKey(
  profileId: string,
  apiKeyInput: string,
  root: string,
): Promise<IrisAgentProviderProfileInfo[]> {
  const apiKey = apiKeyInput.trim();
  if (!apiKey) throw new Error('API key is required.');
  if (apiKey.length > 20_000) throw new Error('API key is too long.');
  const profiles = await loadStoredIrisAgentProviderProfiles(root);
  if (!profiles.some((profile) => profile.id === profileId)) {
    throw new Error('Provider profile was not found.');
  }
  const updated = profiles.map((profile) => profile.id === profileId
    ? { ...profile, apiKey }
    : profile);
  await writeProviderProfileFile(providerProfilesPath(root), updated);
  return profilesForRenderer(updated);
}

export async function removeIrisAgentProviderProfile(
  profileId: string,
  root: string,
): Promise<IrisAgentProviderProfileInfo[]> {
  const profiles = await loadStoredIrisAgentProviderProfiles(root);
  if (!profiles.some((profile) => profile.id === profileId)) {
    throw new Error('Provider profile was not found.');
  }
  const remaining = profiles.filter((profile) => profile.id !== profileId);
  await writeProviderProfileFile(providerProfilesPath(root), remaining);
  return profilesForRenderer(remaining);
}

export function findIrisAgentProviderTemplate(id: string): IrisAgentProviderTemplate | undefined {
  return IRIS_AGENT_PROVIDER_TEMPLATES.find((template) => template.id === id);
}

export function runtimeProviderId(profileId: string): string {
  return `iris-profile-${profileId}`;
}

export function profilesForRenderer(
  profiles: readonly StoredIrisAgentProviderProfile[],
): IrisAgentProviderProfileInfo[] {
  return profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    templateId: profile.templateId,
    baseUrl: profile.baseUrl,
    hasCredential: profile.apiKey.length > 0,
    models: profile.models?.map((model) => ({ ...model })) ?? [],
  }));
}

function normalizeConfiguredModel(model: IrisAgentConfiguredModel): IrisAgentConfiguredModel {
  const contextWindowTokens = Math.max(1, Math.floor(model.contextWindowTokens || 128_000));
  const maxOutputTokens = Math.max(1, Math.min(contextWindowTokens - 1, Math.floor(model.maxOutputTokens || 16_384)));
  const reserveOutputTokens = Math.max(1, Math.min(contextWindowTokens - 1, Math.floor(model.reserveOutputTokens || 16_384)));
  const keepRecentTokens = Math.max(1, Math.min(contextWindowTokens - 1, Math.floor(model.keepRecentTokens || 20_000)));
  return {
    modelId: model.modelId.trim(),
    displayName: model.displayName.trim() || model.modelId.trim(),
    ...(model.api ? { api: model.api } : {}),
    contextWindowTokens,
    maxOutputTokens,
    reserveOutputTokens,
    keepRecentTokens,
    compactTrigger: Math.max(1, Math.min(contextWindowTokens - 1, Math.floor(model.compactTrigger || contextWindowTokens - reserveOutputTokens))),
    ...(isCustomParameters(model.customParameters) ? { customParameters: model.customParameters } : {}),
    enabled: model.enabled !== false,
    source: model.source === 'manual' ? 'manual' : 'discovered',
    ...(model.lastVerifiedAt ? { lastVerifiedAt: model.lastVerifiedAt } : {}),
    ...(model.verificationError ? { verificationError: model.verificationError } : {}),
  };
}

function isCustomParameters(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function profileModelsConfig(
  sourceModels: readonly Model<Api>[],
  api: IrisAgentProviderTemplate['api'],
  modelIds: readonly string[],
  configuredModels: readonly IrisAgentConfiguredModel[] = [],
) {
  const sourceById = new Map(sourceModels.map((model) => [model.id, model]));
  const configuredById = new Map(configuredModels.map((model) => [model.modelId, model]));
  return modelIds.map((id) => {
    const configured = configuredById.get(id);
    const model = sourceById.get(id);
    if (!model) {
      return {
        id,
        name: id,
        api,
        reasoning: false,
        input: ['text'] as ('text' | 'image')[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: configured?.contextWindowTokens ?? 128_000,
        maxTokens: configured?.maxOutputTokens ?? 16_384,
      };
    }
    return {
      id: model.id,
      name: model.name,
      api,
      reasoning: model.reasoning,
      input: [...model.input],
      cost: model.cost,
      contextWindow: configured?.contextWindowTokens ?? model.contextWindow,
      maxTokens: configured?.maxOutputTokens ?? model.maxTokens,
      ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
      ...(model.compat ? { compat: model.compat } : {}),
    };
  });
}

function isStoredProfile(value: unknown): value is StoredIrisAgentProviderProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return typeof profile.id === 'string' && profile.id.length > 0
    && typeof profile.name === 'string' && profile.name.trim().length > 0
    && typeof profile.templateId === 'string' && !!findIrisAgentProviderTemplate(profile.templateId)
    && typeof profile.baseUrl === 'string'
    && typeof profile.apiKey === 'string' && profile.apiKey.length > 0;
}

async function readProviderProfileFile(path: string): Promise<ProviderProfileFile | null> {
  for (const candidate of [path, `${path}.bak`]) {
    try {
      return JSON.parse(await readFile(candidate, 'utf8')) as ProviderProfileFile;
    } catch {
      // Missing and invalid files both fall through to the backup/default projection.
    }
  }
  return null;
}

async function writeProviderProfileFile(
  path: string,
  profiles: StoredIrisAgentProviderProfile[],
): Promise<void> {
  const value: ProviderProfileFile = { version: 1, profiles };
  await writeFileAtomic(path, JSON.stringify(value, null, 2), {
    beforeReplace: async () => {
      try {
        await copyFile(path, `${path}.bak`);
      } catch {
        // Backup is best-effort; the same-directory atomic replacement remains authoritative.
      }
    },
  });
}
