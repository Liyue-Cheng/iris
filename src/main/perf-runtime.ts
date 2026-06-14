import { performance } from 'node:perf_hooks';
import {
  PERF_RING_LIMIT,
  cleanPerfTags,
  type LoosePerfTags,
  type PerfEvent,
  type PerfProcess,
  type PerfSnapshot,
} from '@shared/perf';

const PROCESS: PerfProcess = 'main';
const events: PerfEvent[] = [];
let nextId = 1;

function now(): number {
  return Date.now();
}

function push(event: PerfEvent): void {
  events.push(event);
  if (events.length > PERF_RING_LIMIT) {
    events.splice(0, events.length - PERF_RING_LIMIT);
  }
}

function id(): string {
  return `${PROCESS}-${nextId++}`;
}

export const perf = {
  span(name: string, durationMs: number, tags?: LoosePerfTags): void {
    push({
      id: id(),
      ts: now(),
      process: PROCESS,
      kind: 'span',
      name,
      durationMs,
      tags: cleanPerfTags(tags),
    });
  },

  counter(name: string, value: number, tags?: LoosePerfTags): void {
    push({
      id: id(),
      ts: now(),
      process: PROCESS,
      kind: 'counter',
      name,
      value,
      tags: cleanPerfTags(tags),
    });
  },

  gauge(name: string, value: number, tags?: LoosePerfTags): void {
    push({
      id: id(),
      ts: now(),
      process: PROCESS,
      kind: 'gauge',
      name,
      value,
      tags: cleanPerfTags(tags),
    });
  },

  async measure<T>(name: string, fn: () => Promise<T>, tags?: LoosePerfTags): Promise<T> {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      this.span(name, performance.now() - started, tags);
    }
  },

  measureSync<T>(name: string, fn: () => T, tags?: LoosePerfTags): T {
    const started = performance.now();
    try {
      return fn();
    } finally {
      this.span(name, performance.now() - started, tags);
    }
  },

  snapshot(): PerfSnapshot {
    return {
      process: PROCESS,
      exportedAt: now(),
      limit: PERF_RING_LIMIT,
      events: [...events],
    };
  },

  clear(): void {
    events.length = 0;
  },
};
