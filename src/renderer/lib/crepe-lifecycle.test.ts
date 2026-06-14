import { describe, expect, it, vi } from 'vitest';
import { mountCrepeSerially } from './crepe-lifecycle';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

describe('mountCrepeSerially', () => {
  it('does not create the next Crepe on the same root until the previous one is destroyed', async () => {
    const root = {} as HTMLElement;
    const events: string[] = [];
    const firstDestroy = deferred();
    const secondCreated = deferred();

    const first = {
      create: async (): Promise<void> => {
        events.push('first:create');
      },
      destroy: async (): Promise<void> => {
        events.push('first:destroy:start');
        await firstDestroy.promise;
        events.push('first:destroy:end');
      },
    };
    const second = {
      create: async (): Promise<void> => {
        events.push('second:create');
        secondCreated.resolve();
      },
      destroy: async (): Promise<void> => {
        events.push('second:destroy');
      },
    };

    const firstLifecycle = mountCrepeSerially({ root, crepe: first });
    await flushMicrotasks();
    const secondLifecycle = mountCrepeSerially({ root, crepe: second });
    await flushMicrotasks();

    expect(events).toEqual(['first:create']);

    firstLifecycle.stop();
    await flushMicrotasks();
    expect(events).toEqual(['first:create', 'first:destroy:start']);

    firstDestroy.resolve();
    await secondCreated.promise;
    expect(events).toEqual([
      'first:create',
      'first:destroy:start',
      'first:destroy:end',
      'second:create',
    ]);

    secondLifecycle.stop();
    await flushMicrotasks();
    expect(events).toEqual([
      'first:create',
      'first:destroy:start',
      'first:destroy:end',
      'second:create',
      'second:destroy',
    ]);
  });

  it('destroys a Crepe whose create resolves after stop and skips onCreated', async () => {
    const root = {} as HTMLElement;
    const createStarted = deferred();
    const createDone = deferred();
    const destroyed = deferred();
    const onCreated = vi.fn();

    const crepe = {
      create: async (): Promise<void> => {
        createStarted.resolve();
        await createDone.promise;
      },
      destroy: async (): Promise<void> => {
        destroyed.resolve();
      },
    };

    const lifecycle = mountCrepeSerially({ root, crepe, onCreated });
    await createStarted.promise;
    lifecycle.stop();
    createDone.resolve();
    await destroyed.promise;

    expect(onCreated).not.toHaveBeenCalled();
  });
});
