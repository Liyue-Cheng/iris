import type { ProjectScope, SessionOutputPayload } from '@shared/types';

export interface TerminalOutputAttachment {
  sessionId: string;
  attachmentId: string;
  scope: ProjectScope;
}

export function shouldForwardTerminalOutput(
  attachment: TerminalOutputAttachment | null,
  output: SessionOutputPayload,
): boolean {
  return !!(
    attachment &&
    attachment.sessionId === output.sessionId &&
    attachment.scope.root === output.scope.root &&
    attachment.scope.generation === output.scope.generation
  );
}

export function detachTerminalOutput(
  attachment: TerminalOutputAttachment | null,
  attachmentId: string,
): TerminalOutputAttachment | null {
  return attachment?.attachmentId === attachmentId ? null : attachment;
}
