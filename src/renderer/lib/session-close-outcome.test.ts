import { describe, expect, it } from 'vitest';
import { sessionCloseOutcome } from './session-close-outcome';

describe('session close outcome', () => {
  it('normalizes success, cancellation, and lifecycle conflicts', () => {
    expect(sessionCloseOutcome({ status: 'ok', value: undefined })).toEqual({ status: 'closed' });
    expect(sessionCloseOutcome({ status: 'cancelled' })).toEqual({ status: 'cancelled' });
    expect(sessionCloseOutcome({ status: 'failed', error: error('SessionCloseConfirmationRequired') }))
      .toEqual({ status: 'confirmation-required' });
    expect(sessionCloseOutcome({ status: 'failed', error: error('SessionRevisionConflict') }))
      .toEqual({ status: 'revision-conflict' });
    expect(sessionCloseOutcome({ status: 'failed', error: error('SessionNotFound') }))
      .toEqual({ status: 'not-found' });
  });
});

function error(code: string) {
  return {
    domain: 'session' as const,
    code,
    message: code,
    retryable: false,
    cause: new Error(code),
  };
}
