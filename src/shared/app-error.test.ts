import { describe, expect, it } from 'vitest';
import { RemoteAppError, isIpcResult, type SerializedAppError } from './app-error';

describe('IPC error contract', () => {
  it('validates result envelopes and reconstructs remote errors', () => {
    const serialized: SerializedAppError = {
      version: 1,
      incidentId: 'incident',
      requestId: 'request',
      domain: 'document',
      code: 'WriteConflict',
      message: 'Document changed',
      retryable: true,
    };
    const result = { ok: false as const, error: serialized };

    expect(isIpcResult(result)).toBe(true);
    expect(new RemoteAppError(serialized)).toMatchObject(serialized);
  });

  it('rejects malformed envelopes', () => {
    expect(isIpcResult({ ok: false, error: new Error('legacy') })).toBe(false);
    expect(isIpcResult({ ok: true })).toBe(false);
  });
});
