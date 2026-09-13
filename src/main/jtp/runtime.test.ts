import { describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { JtpRegistry } from './registry';
import { JtpRuntime } from './runtime';

describe('JtpRuntime', () => {
  it('validates, routes, disables, and deduplicates calls', async () => {
    const invoke = vi.fn(async (request: { id: string }) => ({ id: request.id, ok: true as const, result: { value: 1 } }));
    const registry = new JtpRegistry();
    registry.register({ id: 'test.read', title: 'Read', description: 'Read value', inputSchema: Type.Object({ key: Type.String() }), effects: 'read', provider: 'test', enabledByDefault: true }, { invoke });
    const runtime = new JtpRuntime(registry);
    expect((await runtime.invoke({ id: 'bad', tool: 'test.read', arguments: {} })).ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(await runtime.invoke({ id: 'one', tool: 'test.read', arguments: { key: 'a' } })).toEqual({ id: 'one', ok: true, result: { value: 1 } });
    expect((await runtime.invoke({ id: 'one', tool: 'test.read', arguments: { key: 'a' } })).ok).toBe(false);
    registry.setEnabled([]);
    expect((await runtime.invoke({ id: 'two', tool: 'test.read', arguments: { key: 'a' } })).ok).toBe(false);
  });
});
