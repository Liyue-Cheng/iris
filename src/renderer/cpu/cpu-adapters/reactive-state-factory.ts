/**
 * React-flavored IReactiveState factory — the Iris counterpart of cutie's
 * vueAdapter. front-cpu only needs get/set/subscribe; React components attach
 * via useSyncExternalStore (see useReactiveState below), so the store itself
 * stays framework-free.
 */
import { useSyncExternalStore } from 'react';
import type { IReactiveState } from 'front-cpu';

export function createReactiveState<T>(initialValue: T): IReactiveState<T> {
  let value = initialValue;
  const subscribers = new Set<(value: T) => void>();

  return {
    get value() {
      return value;
    },
    setValue(newValue: T) {
      value = newValue;
      subscribers.forEach((cb) => cb(newValue));
    },
    subscribe(callback: (value: T) => void) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
  };
}

/** Subscribe a React component to an IReactiveState. */
export function useReactiveState<T>(state: IReactiveState<T>): T {
  return useSyncExternalStore(
    (onStoreChange) => state.subscribe(() => onStoreChange()),
    () => state.value,
  );
}
