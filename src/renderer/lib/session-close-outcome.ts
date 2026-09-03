import type { ActionOutcome } from './action-runtime';

export type SessionCloseOutcome =
  | { status: 'closed' }
  | { status: 'cancelled' }
  | { status: 'confirmation-required' }
  | { status: 'revision-conflict' }
  | { status: 'not-found' }
  | { status: 'failed' };

export function sessionCloseOutcome(outcome: ActionOutcome<void>): SessionCloseOutcome {
  if (outcome.status === 'ok') return { status: 'closed' };
  if (outcome.status === 'cancelled') return { status: 'cancelled' };
  if (outcome.error.code === 'SessionCloseConfirmationRequired') {
    return { status: 'confirmation-required' };
  }
  if (outcome.error.code === 'SessionRevisionConflict') return { status: 'revision-conflict' };
  if (outcome.error.code === 'SessionNotFound') return { status: 'not-found' };
  return { status: 'failed' };
}
