/**
 * @file lib/terminal-trace.ts
 * @purpose End-to-end tracing of ONE terminal event — from the user's click
 *   (open a new session / switch to another) all the way to the first painted
 *   frame. Unlike perf-runtime (which records isolated spans), this stitches
 *   the whole gesture into a single ordered timeline that crosses async
 *   boundaries and the renderer↔main IPC, so a multi-second stall shows up as
 *   a visible gap between two adjacent marks instead of a mystery total.
 *
 * Correlation: an 'open' trace starts before the sessionId exists (at click),
 * records the pre-spawn awaits, then binds the sessionId once the spawn IPC
 * returns; TerminalView picks the trace back up by sessionId for the mount /
 * replay / reveal marks. A 'switch' trace already knows its sessionId at click
 * (selecting an existing session); switching remounts TerminalView, so it picks
 * the trace up by sessionId and records the same mount / replay / reveal marks.
 *
 * Each mark stores an offset (ms) from the trace's t0, measured with
 * performance.now() (monotonic, sub-ms). The PerfPanel "终端事件" tab renders
 * the marks as a waterfall with per-step deltas.
 */
import { useSyncExternalStore } from 'react';

export type TerminalTraceKind = 'open' | 'switch';

export interface TraceMark {
  phase: string;
  /** ms offset from the trace's t0. */
  at: number;
}

export interface TerminalTrace {
  id: string;
  kind: TerminalTraceKind;
  /** Human label (agent id for opens, session name for switches). */
  label: string;
  sessionId: string | null;
  /** Date.now() at click — for display + sort only. */
  startedAtWall: number;
  /** performance.now() baseline; all marks are offsets from this. */
  t0: number;
  marks: TraceMark[];
  /** Offset (ms) of the terminating mark, or null while in flight. */
  endedAt: number | null;
}

const MAX_TRACES = 40;
const traces: TerminalTrace[] = [];
const subscribers = new Set<() => void>();
let snapshot: TerminalTrace[] = [];

function refresh(): void {
  // Fresh array + cloned marks so useSyncExternalStore sees a new reference
  // only when something actually changed.
  snapshot = traces.map((t) => ({ ...t, marks: t.marks.slice() }));
  subscribers.forEach((cb) => cb());
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function find(id: string): TerminalTrace | undefined {
  for (let i = traces.length - 1; i >= 0; i--) {
    const t = traces[i];
    if (t && t.id === id) return t;
  }
  return undefined;
}

export function beginTerminalTrace(
  kind: TerminalTraceKind,
  opts?: { sessionId?: string; label?: string },
): string {
  const t: TerminalTrace = {
    id: newId(),
    kind,
    label: opts?.label ?? '',
    sessionId: opts?.sessionId ?? null,
    startedAtWall: Date.now(),
    t0: performance.now(),
    marks: [],
    endedAt: null,
  };
  traces.push(t);
  if (traces.length > MAX_TRACES) traces.splice(0, traces.length - MAX_TRACES);
  refresh();
  return t.id;
}

export function traceMark(id: string | null | undefined, phase: string): void {
  if (!id) return;
  const t = find(id);
  if (!t || t.endedAt !== null) return;
  t.marks.push({ phase, at: performance.now() - t.t0 });
  refresh();
}

export function bindTraceSession(id: string | null | undefined, sessionId: string): void {
  if (!id) return;
  const t = find(id);
  if (!t) return;
  t.sessionId = sessionId;
  refresh();
}

/** The most recent still-in-flight trace bound to this session, if any. */
export function traceForSession(sessionId: string): TerminalTrace | null {
  for (let i = traces.length - 1; i >= 0; i--) {
    const t = traces[i];
    if (t && t.sessionId === sessionId && t.endedAt === null) return t;
  }
  return null;
}

export function endTerminalTrace(id: string | null | undefined, phase?: string): void {
  if (!id) return;
  const t = find(id);
  if (!t || t.endedAt !== null) return;
  const at = performance.now() - t.t0;
  if (phase) t.marks.push({ phase, at });
  t.endedAt = at;
  refresh();
}

export function clearTerminalTraces(): void {
  traces.length = 0;
  refresh();
}

function getSnapshot(): TerminalTrace[] {
  return snapshot;
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function useTerminalTraces(): TerminalTrace[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}
