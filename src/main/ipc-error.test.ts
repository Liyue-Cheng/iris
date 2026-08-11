import { describe, expect, it } from 'vitest';
import { AppError } from '@shared/app-error';
import { serializeIpcError } from './ipc-error';

describe('serializeIpcError', () => {
  it('preserves safe structured fields and request correlation', () => {
    const error = new AppError('prompt', 'PromptNotReady', 'Sync prompt entries', {
      details: { repairable: true, issues: [{ layer: 'software', state: 'drifted' }] },
      retryable: true,
    });

    expect(serializeIpcError(
      'session:open',
      error,
      { requestId: 'request-1', correlationId: 'correlation-1' },
      'incident-1',
    )).toEqual({
      version: 1,
      incidentId: 'incident-1',
      requestId: 'request-1',
      correlationId: 'correlation-1',
      domain: 'prompt',
      code: 'PromptNotReady',
      message: 'Sync prompt entries',
      details: { repairable: true, issues: [{ layer: 'software', state: 'drifted' }] },
      retryable: true,
    });
  });

  it('maps unknown session failures without serializing stacks', () => {
    const error = new Error('PTY failed');
    error.stack = 'sensitive stack';
    const result = serializeIpcError(
      'session:open',
      error,
      { requestId: 'request-2' },
      'incident-2',
    );

    expect(result).toEqual({
      version: 1,
      incidentId: 'incident-2',
      requestId: 'request-2',
      domain: 'session',
      code: 'Unexpected',
      message: 'PTY failed',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain('sensitive stack');
  });
});
