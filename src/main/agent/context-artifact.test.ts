import { describe, expect, it } from 'vitest';
import { collectKnownSecrets, sanitizeProviderPayload, sanitizeProviderContextCall } from './context-artifact';

describe('provider context sanitization', () => {
  it('keeps the payload readable while dropping secret fields', () => {
    const sanitized = sanitizeProviderPayload({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      apiKey: 'sk-secret-value',
      headers: { authorization: 'Bearer sk-secret-value' },
    });
    expect(sanitized).toEqual({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('replaces image bytes with a placeholder instead of storing a second copy', () => {
    // Pi and Anthropic shapes carry the base64 on the block itself.
    const piBlock = sanitizeProviderPayload({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', mimeType: 'image/png', data: 'A'.repeat(400) },
        ],
      }],
    });
    expect(JSON.stringify(piBlock)).not.toContain('AAAA');
    expect(JSON.stringify(piBlock)).toContain('image attachment');

    const anthropicBlock = sanitizeProviderPayload({
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(400) } }],
      }],
    });
    expect(JSON.stringify(anthropicBlock)).not.toContain('BBBB');
    expect(JSON.stringify(anthropicBlock)).toContain('image attachment');

    // OpenAI's shape puts a data URL inside a string field.
    const openAiBlock = sanitizeProviderPayload({
      input: [{
        role: 'user',
        content: [{ type: 'input_image', image_url: `data:image/png;base64,${'C'.repeat(400)}` }],
      }],
    });
    expect(JSON.stringify(openAiBlock)).not.toContain('CCCC');
    expect(JSON.stringify(openAiBlock)).toContain('image attachment');
  });

  it('reports the real byte size of the omitted image rather than nothing', () => {
    const sanitized = sanitizeProviderPayload({
      messages: [{ role: 'user', content: [{ type: 'image', data: 'A'.repeat(400) }] }],
    });
    const text = JSON.stringify(sanitized);
    // 400 base64 characters decode to 300 bytes.
    expect(text).toContain('300 bytes');
  });

  it('still redacts a known secret that appears inside a text part', () => {
    const secrets = collectKnownSecrets(['sk-live-1234567890']);
    const sanitized = sanitizeProviderContextCall({
      index: 1,
      capturedAt: 1,
      provider: 'openai',
      model: 'gpt-test',
      api: 'openai-responses',
      payload: { messages: [{ role: 'user', content: 'token sk-live-1234567890 here' }] },
    }, secrets);
    expect(JSON.stringify(sanitized)).not.toContain('sk-live-1234567890');
    expect(JSON.stringify(sanitized)).toContain('[REDACTED]');
  });
});
