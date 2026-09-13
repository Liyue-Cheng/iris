import { describe, expect, it } from 'vitest';
import { JtpRegistry } from './registry';

describe('JtpRegistry', () => {
  it('projects a stable enabled snapshot for settings/UI', () => {
    const registry = new JtpRegistry();
    const provider = { invoke: async (request: any) => ({ id: request.id, ok: true as const, result: {} }) };
    registry.register({
      id: 'demo.read', title: 'Demo', description: 'Demo tool',
      inputSchema: { type: 'object' }, effects: 'read', provider: 'builtin', enabledByDefault: true,
    }, provider);
    expect(registry.snapshot()).toEqual([expect.objectContaining({ id: 'demo.read', enabled: true })]);
    registry.setEnabled([]);
    expect(registry.snapshot()[0]?.enabled).toBe(false);
    expect(registry.modelTools()).toEqual([]);
  });
});
