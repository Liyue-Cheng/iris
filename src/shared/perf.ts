export const PERF_RING_LIMIT = 500;

export type PerfProcess = 'main' | 'renderer';
export type PerfMetricKind = 'span' | 'counter' | 'gauge';
export type PerfTagValue = string | number | boolean | null;
export type PerfTags = Record<string, PerfTagValue>;

interface PerfEventBase {
  id: string;
  ts: number;
  process: PerfProcess;
  kind: PerfMetricKind;
  name: string;
  tags?: PerfTags | undefined;
}

export interface PerfSpanEvent extends PerfEventBase {
  kind: 'span';
  durationMs: number;
}

export interface PerfCounterEvent extends PerfEventBase {
  kind: 'counter';
  value: number;
}

export interface PerfGaugeEvent extends PerfEventBase {
  kind: 'gauge';
  value: number;
}

export type PerfEvent = PerfSpanEvent | PerfCounterEvent | PerfGaugeEvent;

export interface PerfSnapshot {
  process: PerfProcess;
  exportedAt: number;
  limit: number;
  events: PerfEvent[];
}

export type LoosePerfTags = Record<string, PerfTagValue | undefined>;

export function cleanPerfTags(tags?: LoosePerfTags): PerfTags | undefined {
  if (!tags) return undefined;
  const out: PerfTags = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
