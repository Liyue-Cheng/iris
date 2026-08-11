import { useSyncExternalStore } from 'react';
import type {
  HealthDomain,
  ServiceHealthChangedEvent,
} from '@shared/app-error';
import type { ProjectScope } from '@shared/types';
import { normalizeUiError, type UiAppError } from '@renderer/lib/action-runtime';
import { sameProjectScope } from './project-scope-state';

export interface HealthIssue {
  key: string;
  domain: HealthDomain;
  state: 'degraded' | 'recovering';
  error: UiAppError;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrences: number;
  scope: ProjectScope | null;
  retry?: () => Promise<void>;
}

interface DegradeInput {
  key: string;
  domain: HealthDomain;
  cause: unknown;
  scope: ProjectScope | null;
  retry?: () => Promise<void>;
}

let issues: readonly HealthIssue[] = [];
const subscribers = new Set<() => void>();

function emit(): void {
  subscribers.forEach((subscriber) => subscriber());
}

function scopedKey(key: string, scope: ProjectScope | null): string {
  return `${scope?.root ?? 'global'}:${scope?.generation ?? 0}:${key}`;
}

export const healthStore = {
  get(): readonly HealthIssue[] {
    return issues;
  },

  degrade(input: DegradeInput): void {
    const key = scopedKey(input.key, input.scope);
    const now = Date.now();
    const existingIndex = issues.findIndex((issue) => issue.key === key);
    const error = normalizeUiError(input.cause);
    if (existingIndex >= 0) {
      const existing = issues[existingIndex]!;
      const updated: HealthIssue = {
        ...existing,
        state: 'degraded',
        error,
        lastSeenAt: now,
        occurrences: existing.occurrences + 1,
        ...(input.retry !== undefined ? { retry: input.retry } : {}),
      };
      issues = [
        ...issues.slice(0, existingIndex),
        updated,
        ...issues.slice(existingIndex + 1),
      ];
    } else {
      issues = [...issues, {
        key,
        domain: input.domain,
        state: 'degraded',
        error,
        firstSeenAt: now,
        lastSeenAt: now,
        occurrences: 1,
        scope: input.scope,
        ...(input.retry !== undefined ? { retry: input.retry } : {}),
      }];
    }
    emit();
  },

  resolve(key: string, scope: ProjectScope | null): void {
    const target = scopedKey(key, scope);
    const next = issues.filter((issue) => issue.key !== target);
    if (next.length === issues.length) return;
    issues = next;
    emit();
  },

  resetForScope(scope: ProjectScope | null): void {
    const next = issues.filter((issue) => sameProjectScope(issue.scope, scope));
    if (next.length === issues.length) return;
    issues = next;
    emit();
  },

  clear(): void {
    if (issues.length === 0) return;
    issues = [];
    emit();
  },

  handleServiceEvent(event: ServiceHealthChangedEvent): void {
    const key = event.domain;
    if (event.state === 'healthy') {
      this.resolve(key, event.projectScope);
      return;
    }
    this.degrade({
      key,
      domain: event.domain,
      cause: event.error ?? new Error(`${event.domain} is unavailable`),
      scope: event.projectScope,
    });
  },

  async retry(issue: HealthIssue): Promise<void> {
    if (!issue.retry || issue.state === 'recovering') return;
    issues = issues.map((candidate) =>
      candidate.key === issue.key ? { ...candidate, state: 'recovering' } : candidate,
    );
    emit();
    try {
      await issue.retry();
      issues = issues.filter((candidate) => candidate.key !== issue.key);
      emit();
    } catch (cause) {
      this.degrade({
        key: issue.domain,
        domain: issue.domain,
        cause,
        scope: issue.scope,
        retry: issue.retry,
      });
    }
  },
};

export function useHealthIssues(): readonly HealthIssue[] {
  return useSyncExternalStore(
    (subscriber) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    healthStore.get,
  );
}
