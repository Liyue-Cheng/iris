import {
  PERF_RING_LIMIT,
  cleanPerfTags,
  type LoosePerfTags,
  type PerfEvent,
  type PerfProcess,
  type PerfSnapshot,
} from '@shared/perf';

const PROCESS: PerfProcess = 'renderer';
const events: PerfEvent[] = [];
const subscribers = new Set<() => void>();
let nextId = 1;
let cachedSnapshot: PerfSnapshot = {
  process: PROCESS,
  exportedAt: Date.now(),
  limit: PERF_RING_LIMIT,
  events: [],
};

function now(): number {
  return Date.now();
}

function id(): string {
  return `${PROCESS}-${nextId++}`;
}

function emit(): void {
  subscribers.forEach((cb) => cb());
}

function refreshSnapshot(): void {
  cachedSnapshot = {
    process: PROCESS,
    exportedAt: now(),
    limit: PERF_RING_LIMIT,
    events: [...events],
  };
}

function push(event: PerfEvent): void {
  events.push(event);
  if (events.length > PERF_RING_LIMIT) {
    events.splice(0, events.length - PERF_RING_LIMIT);
  }
  refreshSnapshot();
  emit();
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

  snapshot(): PerfSnapshot {
    return cachedSnapshot;
  },

  clear(): void {
    events.length = 0;
    refreshSnapshot();
    emit();
  },

  subscribe(cb: () => void): () => void {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  },
};

export function installRendererPerfObservers(): void {
  const observerCtor = window.PerformanceObserver;
  if (observerCtor) {
    try {
      const observer = new observerCtor((list) => {
        for (const entry of list.getEntries()) {
          perf.span('renderer.longTask', entry.duration, {
            entryType: entry.entryType,
          });
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      // Long Task support varies by Chromium build; the monitor is optional.
    }
  }

  const perfMemory = (): { usedJSHeapSize?: number } | undefined =>
    (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;

  const tick = (): void => {
    const used = perfMemory()?.usedJSHeapSize;
    if (typeof used === 'number') {
      perf.gauge('renderer.heap.usedBytes', used);
    }
  };
  tick();
  window.setInterval(tick, 5000);
}
