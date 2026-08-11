import { describe, expect, it, vi } from 'vitest';
import { TerminalSessionRuntime } from './terminal-runtime';

describe('TerminalSessionRuntime', () => {
  it('binds immutable session scope and invalidates captured epochs on dispose', () => {
    const runtime = new TerminalSessionRuntime('session-1', { root: 'C:\\work', generation: 2 });
    const epoch = runtime.capture();
    expect(runtime.isCurrent(epoch)).toBe(true);
    runtime.dispose();
    expect(runtime.isCurrent(epoch)).toBe(false);
    expect(runtime.transition({ type: 'ATTACH' })).toBe(false);
  });

  it('releases owned resources once in reverse registration order', () => {
    const runtime = new TerminalSessionRuntime('session-1', { root: 'C:\\work', generation: 2 });
    const order: string[] = [];
    runtime.own(() => order.push('first'));
    runtime.own(() => order.push('second'));
    runtime.dispose();
    runtime.dispose();
    expect(order).toEqual(['second', 'first']);
  });

  it('immediately releases resources registered after disposal', () => {
    const runtime = new TerminalSessionRuntime('session-1', { root: 'C:\\work', generation: 2 });
    runtime.dispose();
    const dispose = vi.fn();
    runtime.own(dispose);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
