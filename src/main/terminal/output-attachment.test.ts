import { describe, expect, it } from 'vitest';
import { detachTerminalOutput, shouldForwardTerminalOutput } from './output-attachment';

const attachment = {
  sessionId: 'visible',
  attachmentId: 'visible:2',
  scope: { root: 'C:\\work', generation: 3 },
};

describe('terminal output attachment', () => {
  it('forwards only the attached session in the attached project generation', () => {
    expect(
      shouldForwardTerminalOutput(attachment, {
        scope: attachment.scope,
        sessionId: 'visible',
        data: '',
        seq: 1,
      }),
    ).toBe(true);
    expect(
      shouldForwardTerminalOutput(attachment, {
        scope: attachment.scope,
        sessionId: 'hidden',
        data: '',
        seq: 1,
      }),
    ).toBe(false);
  });

  it('does not let a stale runtime detach the current attachment', () => {
    expect(detachTerminalOutput(attachment, 'visible:1')).toBe(attachment);
    expect(detachTerminalOutput(attachment, 'visible:2')).toBeNull();
  });
});
