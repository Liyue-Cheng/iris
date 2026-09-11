import type {
  IrisAgentProviderContextBundle,
  IrisAgentProviderContextCall,
  IrisJsonValue,
} from '@shared/types';
import type { AgentInvokeAttempt } from './session-model';

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
    ...(call.reasoning ? {
      reasoning: {
        configured: call.reasoning.configured,
        effective: call.reasoning.effective,
        ...(call.reasoning.downgradeReason
          ? { downgradeReason: redact(call.reasoning.downgradeReason, knownSecrets) }
          : {}),
      },
    } : {}),
    payload: sanitizeProviderPayload(call.payload, knownSecrets),
  };
}

export function renderProviderContextIndex(
  bundle: IrisAgentProviderContextBundle,
  calls: readonly IrisAgentProviderContextCall[],
  attempts: readonly AgentInvokeAttempt[] = [],
): string {
  return [
    'Iris Agent provider context bundle',
    `Schema: ${bundle.schemaVersion}`,
    `Session: ${bundle.sessionId}`,
    `Intent: ${bundle.intentId}`,
    ...(bundle.runtimeIdentity
      ? [
          `App: ${bundle.runtimeIdentity.appVersion}`,
          `Protocol: ${bundle.runtimeIdentity.protocolVersion}`,
          `Session revision: ${bundle.runtimeIdentity.sessionRevision}`,
          `Worker epoch: ${bundle.runtimeIdentity.workerEpoch}`,
        ]
      : []),
    `Provider calls: ${bundle.calls.length}`,
    `Provider attempts: ${attempts.length}`,
    '',
    JSON.stringify(bundle, null, 2),
    ...(attempts.length > 0
      ? [
          '',
          'Provider attempt audit',
          '',
          JSON.stringify(attempts, null, 2),
        ]
      : []),
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

/**
 * A payload can carry image bytes in several provider shapes: Pi's own
 * `{type:'image', data}` block, Anthropic's `{type:'image', source:{data}}`,
 * and OpenAI's `data:` URL inside `image_url`. Every one of them is replaced by
 * a short placeholder; an audit artifact must record that an image was sent
 * without becoming a second copy of it.
 */
const DATA_IMAGE_URL = /^data:image\/[a-z\d.+-]+;base64,/iu;

function sanitizeValue(
  value: unknown,
  knownSecrets: readonly string[],
  allowObjectKeys: boolean,
): IrisJsonValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    if (DATA_IMAGE_URL.test(value)) return imagePlaceholder(value.length);
    return redact(value, knownSecrets);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeValue(item, knownSecrets, true))
      .filter((item): item is IrisJsonValue => item !== undefined);
  }
  if (!isRecord(value) || !allowObjectKeys) return undefined;
  const imageBytes = embeddedImageBytes(value);
  if (imageBytes !== null) return imagePlaceholder(imageBytes);
  const sanitized: Record<string, IrisJsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) continue;
    const next = sanitizeValue(child, knownSecrets, true);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

/** Detect an image content block and report its base64 length, or null. */
function embeddedImageBytes(value: Record<string, unknown>): number | null {
  if (value.type !== 'image' && value.type !== 'input_image' && value.type !== 'image_url') return null;
  for (const candidate of [value.data, value.image_url, (isRecord(value.source) ? value.source.data : undefined)]) {
    if (typeof candidate === 'string') return candidate.length;
  }
  return 0;
}

function imagePlaceholder(encodedChars: number): string {
  // base64 is 4 characters for every 3 bytes, so this reports real size
  // without keeping the payload.
  const bytes = Math.floor((encodedChars * 3) / 4);
  return `[image attachment, ${String(bytes)} bytes, not stored in this artifact]`;
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
