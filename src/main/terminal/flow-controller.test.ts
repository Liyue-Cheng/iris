import { describe, expect, it, vi } from 'vitest';
import { TerminalFlowController } from './flow-controller';

describe('TerminalFlowController', () => {
  it('resumes only after every necessary consumer has recovered', () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const flow = new TerminalFlowController(pause, resume);
    flow.setBlocked('mirror', true);
    flow.setBlocked('renderer', true);
    flow.setBlocked('mirror', false);
    expect(pause).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    flow.setBlocked('renderer', false);
    expect(resume).toHaveBeenCalledOnce();
  });
});
