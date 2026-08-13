import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { AGENT_SUPERVISION_RULE, AgentSupervisionLog, runIsolatedSupervision } from './supervision';

describe('Agent supervision diagnostics', () => {
  it('keeps the no-tools temporary call and its facts outside formal message history', async () => {
    const history = [{ id: 'u1', content: 'run tests' }];
    const supervision = new AgentSupervisionLog();
    const call = vi.fn(async () => ({ outcome: 'normal' as const, usageTokens: 42 }));
    await runIsolatedSupervision(call, {
      terminalId: 'terminal-1',
      command: 'npm test',
      cursorStart: 0,
      cursorEnd: 128,
      overlapOutput: 'previous line',
      incrementalOutput: 'tests passing',
      processState: 'running',
    }, supervision);
    expect(call).toHaveBeenCalledWith(expect.objectContaining({
      systemRule: AGENT_SUPERVISION_RULE,
      tools: [],
    }));
    expect(history).toEqual([{ id: 'u1', content: 'run tests' }]);
    expect(supervision.diagnostics()).toEqual([
      {
        terminalId: 'terminal-1',
        cursorStart: 0,
        cursorEnd: 128,
        outcome: 'normal',
        usageTokens: 42,
      },
    ]);
  });
});
