import { useSyncExternalStore } from 'react';

export interface DocumentNavigationTarget {
  id: number;
  path: string;
  generation: number;
  fragment: string;
}
let sequence = 0;
let target: DocumentNavigationTarget | null = null;
const subscribers = new Set<() => void>();

function emit(): void {
  subscribers.forEach((subscriber) => subscriber());
}

export const documentNavigationStore = {
  get(): DocumentNavigationTarget | null {
    return target;
  },

  request(path: string, generation: number, fragment: string): DocumentNavigationTarget {
    target = { id: ++sequence, path, generation, fragment };
    emit();
    return target;
  },

  consume(expected: DocumentNavigationTarget): boolean {
    if (target?.id !== expected.id) return false;
    target = null;
    emit();
    return true;
  },

  clear(): void {
    if (!target) return;
    target = null;
    emit();
  },
};

export function useDocumentNavigationTarget(): DocumentNavigationTarget | null {
  return useSyncExternalStore(
    (onStoreChange) => {
      subscribers.add(onStoreChange);
      return () => subscribers.delete(onStoreChange);
    },
    () => target,
  );
}
