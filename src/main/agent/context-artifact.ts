import type {
  IrisAgentProviderContextBundle,
  IrisAgentProviderContextCall,
  IrisJsonValue,
} from '@shared/types';

const SAFE_PAYLOAD_KEYS = new Set([
  'model', 'modelId', 'messages', 'input', 'contents', 'config', 'system', 'systemPrompt', 'system_instruction',
  'systemInstruction', 'instructions', 'tools', 'tool_choice', 'toolChoice', 'tool_config',
  'toolConfig', 'max_tokens', 'maxTokens', 'max_output_tokens', 'temperature', 'top_p',
  'topP', 'stop', 'stop_sequences', 'thinking', 'reasoning', 'stream', 'store',
  'parallel_tool_calls', 'response_format', 'generationConfig', 'inferenceConfig',
  'additionalModelRequestFields',
]);

const SECRET_FIELD = /^(?:api[_-]?key|authorization|auth|headers?|credentials?|password|secret|access[_-]?token|refresh[_-]?token|token)$/iu;

export function sanitizeProviderPayload(
  payload: unknown,
  knownSecrets: readonly string[] = [],
): IrisJsonValue {
  if (!isRecord(payload)) return sanitizeValue(payload, knownSecrets, false) ?? null;
  const sanitized: Record<string, IrisJsonValue> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!SAFE_PAYLOAD_KEYS.has(key) || SECRET_FIELD.test(key)) continue;
    const next = sanitizeValue(value, knownSecrets, true);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

export function sanitizeProviderContextCall(
  call: IrisAgentProviderContextCall,
  knownSecrets: readonly string[] = [],
): IrisAgentProviderContextCall {
  return {
    index: call.index,
    capturedAt: call.capturedAt,
    provider: redact(call.provider, knownSecrets),
    model: redact(call.model, knownSecrets),
    api: redact(call.api, knownSecrets),
    payload: sanitizeProviderPayload(call.payload, knownSecrets),
  };
}

export function renderProviderContextIndex(
  bundle: IrisAgentProviderContextBundle,
  calls: readonly IrisAgentProviderContextCall[],
): string {
  return [
    'Iris Agent provider context bundle',
    `Schema: ${bundle.schemaVersion}`,
    `Session: ${bundle.sessionId}`,
    `Turn: ${bundle.turnId}`,
    `Request: ${bundle.requestId}`,
    `Provider calls: ${bundle.calls.length}`,
    '',
    JSON.stringify(bundle, null, 2),
    ...calls.flatMap((call) => ['', renderProviderContextCall(call).trimEnd()]),
    '',
  ].join('\n');
}

export function renderProviderContextCall(call: IrisAgentProviderContextCall): string {
  return [
    `Provider call ${call.index}`,
    `${call.provider}/${call.model} (${call.api})`,
    '',
    JSON.stringify(call, null, 2),
    '',
  ].join('\n');
}

export function collectKnownSecrets(value: unknown): string[] {
  const secrets = new Set<string>();
  collectStrings(value, secrets);
  return [...secrets].filter((secret) => secret.length >= 6);
}

function sanitizeValue(
  value: unknown,
  knownSecrets: readonly string[],
  allowObjectKeys: boolean,
): IrisJsonValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return redact(value, knownSecrets);
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeValue(item, knownSecrets, true))
      .filter((item): item is IrisJsonValue => item !== undefined);
  }
  if (!isRecord(value) || !allowObjectKeys) return undefined;
  const sanitized: Record<string, IrisJsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) continue;
    const next = sanitizeValue(child, knownSecrets, true);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

function redact(value: string, knownSecrets: readonly string[]): string {
  let redacted = value;
  for (const secret of knownSecrets) {
    if (secret.length >= 6) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted;
}

function collectStrings(value: unknown, target: Set<string>): void {
  if (typeof value === 'string') {
    target.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, target);
    return;
  }
  if (!isRecord(value)) return;
  for (const child of Object.values(value)) collectStrings(child, target);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
