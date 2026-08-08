import { describe, expect, it } from 'vitest';
import { retainInitializedCodeBlock } from './stable-code-block';

describe('retainInitializedCodeBlock', () => {
  it('disables off-screen teardown only on the Iris-owned NodeView instance', () => {
    let scheduled = 0;
    const prototype = {
      scheduleTeardown(): void {
        scheduled += 1;
      },
    };
    const first = Object.create(prototype) as object;
    const second = Object.create(prototype) as object;

    retainInitializedCodeBlock(first);
    retainInitializedCodeBlock(first);
    Reflect.apply(Reflect.get(first, 'scheduleTeardown'), first, []);
    Reflect.apply(Reflect.get(second, 'scheduleTeardown'), second, []);

    expect(scheduled).toBe(1);
    expect(Object.hasOwn(first, 'scheduleTeardown')).toBe(true);
    expect(Object.hasOwn(second, 'scheduleTeardown')).toBe(false);
    expect(Reflect.get(prototype, 'scheduleTeardown')).toBe(prototype.scheduleTeardown);
    expect(Object.getOwnPropertyDescriptor(first, 'scheduleTeardown')).toMatchObject({
      configurable: false,
      writable: false,
    });
  });

  it('fails loudly when a Milkdown upgrade removes the lifecycle hook', () => {
    expect(() => retainInitializedCodeBlock({})).toThrow(/scheduleTeardown is missing/);
  });
});
