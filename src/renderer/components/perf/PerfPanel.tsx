import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Activity, Download, Trash2, X } from 'lucide-react';
import { CHANNELS } from '@shared/protocol';
import type { PerfEvent, PerfSnapshot, PerfTags } from '@shared/perf';
import { perf } from '@renderer/lib/perf-runtime';
import { writeClipboardText } from '@renderer/lib/clipboard';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';

let open = false;
const subs = new Set<() => void>();

export function openPerfPanel(): void {
  open = true;
  subs.forEach((cb) => cb());
}

export function closePerfPanel(): void {
  open = false;
  subs.forEach((cb) => cb());
}

export function usePerfPanelOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => open,
  );
}

function useRendererPerfSnapshot(): PerfSnapshot {
  return useSyncExternalStore(perf.subscribe, perf.snapshot);
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 100) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function tagNumber(tags: PerfTags | undefined, key: string): number | null {
  const value = tags?.[key];
  return typeof value === 'number' ? value : null;
}

function tagString(tags: PerfTags | undefined, key: string): string | null {
  const value = tags?.[key];
  return typeof value === 'string' ? value : null;
}

function tagsText(tags: PerfTags | undefined): string {
  if (!tags) return '';
  return Object.entries(tags)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ');
}

function eventValue(event: PerfEvent): string {
  if (event.kind === 'span') return formatMs(event.durationMs);
  if (event.name.toLowerCase().includes('bytes')) return formatBytes(event.value);
  return String(event.value);
}

function latestGauge(events: PerfEvent[], name: string): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.kind === 'gauge' && event.name === name) return event.value;
  }
  return null;
}

type Tab = 'slow' | 'terminal' | 'scan' | 'raw';

interface ReplayGroup {
  replayId: string;
  sessionId: string | null;
  ts: number;
  events: PerfEvent[];
  totalMs: number | null;
}

function buildReplayGroups(events: PerfEvent[]): ReplayGroup[] {
  const groups = new Map<string, ReplayGroup>();
  for (const event of events) {
    if (!event.name.startsWith('terminal.replay.')) continue;
    const replayId = tagString(event.tags, 'replayId');
    if (!replayId) continue;
    const sessionId = tagString(event.tags, 'sessionId');
    let group = groups.get(replayId);
    if (!group) {
      group = {
        replayId,
        sessionId,
        ts: event.ts,
        events: [],
        totalMs: null,
      };
      groups.set(replayId, group);
    }
    group.events.push(event);
    group.ts = Math.max(group.ts, event.ts);
    group.sessionId = group.sessionId ?? sessionId;
    if (event.kind === 'span' && event.name === 'terminal.replay.totalToReveal') {
      group.totalMs = event.durationMs;
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);
}

function getSpan(group: ReplayGroup, name: string): PerfEvent | null {
  return group.events.find((e) => e.kind === 'span' && e.name === name) ?? null;
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="min-w-0 border border-subtle bg-card/40 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{hint}</div>}
    </div>
  );
}

function EventTable({ events }: { events: PerfEvent[] }): JSX.Element {
  return (
    <div className="overflow-hidden border border-subtle">
      <table className="w-full text-[12px]">
        <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="w-24 px-3 py-2 font-medium">进程</th>
            <th className="px-3 py-2 font-medium">指标</th>
            <th className="w-24 px-3 py-2 text-right font-medium">值</th>
            <th className="w-[42%] px-3 py-2 font-medium">标签</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id} className="border-t border-subtle">
              <td className="px-3 py-2 text-muted-foreground">{event.process}</td>
              <td className="px-3 py-2 font-mono text-[11px]">{event.name}</td>
              <td className="px-3 py-2 text-right tabular-nums">{eventValue(event)}</td>
              <td className="truncate px-3 py-2 text-[11px] text-muted-foreground">
                {tagsText(event.tags)}
              </td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td className="px-3 py-8 text-center text-xs text-muted-foreground" colSpan={4}>
                暂无数据
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ReplayWaterfall({ groups }: { groups: ReplayGroup[] }): JSX.Element {
  return (
    <div className="space-y-2">
      {groups.map((group) => {
        const serialize = getSpan(group, 'terminal.replay.serialize');
        const ipc = getSpan(group, 'terminal.replay.ipc');
        const decode = getSpan(group, 'terminal.replay.decode');
        const write = getSpan(group, 'terminal.replay.write');
        const base64Bytes = tagNumber(ipc?.tags, 'base64Bytes');
        const bytes = tagNumber(write?.tags, 'bytes') ?? tagNumber(decode?.tags, 'bytes');
        const chunks = tagNumber(write?.tags, 'chunks');
        const parts = [
          ['serialize', serialize],
          ['IPC', ipc],
          ['decode', decode],
          ['write', write],
        ] as const;
        return (
          <div key={group.replayId} className="border border-subtle bg-card/30 px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="font-mono text-[11px] text-muted-foreground">
                {group.replayId.slice(0, 8)}
              </div>
              <div className="truncate text-[12px] text-muted-foreground">
                session {group.sessionId?.slice(0, 8) ?? 'unknown'}
              </div>
              <div className="ml-auto text-sm font-medium">
                {group.totalMs == null ? '未 reveal' : formatMs(group.totalMs)}
              </div>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {parts.map(([label, event]) => (
                <div key={label} className="bg-muted/40 px-2 py-1">
                  <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
                  <div className="text-[12px] tabular-nums">
                    {event?.kind === 'span' ? formatMs(event.durationMs) : '—'}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {base64Bytes != null && <span>base64 {formatBytes(base64Bytes)}</span>}
              {bytes != null && <span>bytes {formatBytes(bytes)}</span>}
              {chunks != null && <span>chunks {chunks}</span>}
            </div>
          </div>
        );
      })}
      {groups.length === 0 && (
        <div className="border border-subtle px-3 py-8 text-center text-xs text-muted-foreground">
          切换或打开终端后会出现 replay 瀑布
        </div>
      )}
    </div>
  );
}

export function PerfPanel(): JSX.Element | null {
  const isOpen = usePerfPanelOpen();
  const rendererSnapshot = useRendererPerfSnapshot();
  const [mainSnapshot, setMainSnapshot] = useState<PerfSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>('slow');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const refresh = (): void => {
      void window.api
        .invoke<undefined, PerfSnapshot>(CHANNELS.PERF_SNAPSHOT)
        .then((snapshot) => {
          if (!cancelled) setMainSnapshot(snapshot);
        })
        .catch((err) => {
          if (!cancelled) setMessage(err instanceof Error ? err.message : String(err));
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePerfPanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  const events = useMemo(() => {
    const merged = [...(mainSnapshot?.events ?? []), ...rendererSnapshot.events];
    return merged.sort((a, b) => b.ts - a.ts);
  }, [mainSnapshot, rendererSnapshot]);

  const slowSpans = useMemo(
    () =>
      events
        .filter((event): event is Extract<PerfEvent, { kind: 'span' }> => event.kind === 'span')
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 20),
    [events],
  );

  const scans = useMemo(
    () => events.filter((event) => event.kind === 'span' && event.name === 'project.scan').slice(0, 20),
    [events],
  );

  const replayGroups = useMemo(() => buildReplayGroups(events), [events]);

  const recentLongTask = useMemo(() => {
    const cutoff = Date.now() - 60_000;
    return events
      .filter(
        (event): event is Extract<PerfEvent, { kind: 'span' }> =>
          event.kind === 'span' && event.name === 'renderer.longTask' && event.ts >= cutoff,
      )
      .sort((a, b) => b.durationMs - a.durationMs)[0];
  }, [events]);

  const heap = latestGauge(events, 'renderer.heap.usedBytes');

  const exportJson = async (): Promise<void> => {
    const payload = {
      exportedAt: Date.now(),
      main: mainSnapshot,
      renderer: rendererSnapshot,
    };
    const ok = await writeClipboardText(JSON.stringify(payload, null, 2));
    setMessage(ok ? '性能快照已复制到剪贴板' : '复制失败');
  };

  const clear = async (): Promise<void> => {
    perf.clear();
    await window.api.invoke(CHANNELS.PERF_CLEAR);
    setMainSnapshot(null);
    setMessage('已清空性能 ring buffer');
  };

  if (!isOpen) return null;

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'slow', label: '慢操作' },
    { id: 'terminal', label: '终端 replay' },
    { id: 'scan', label: '.iris 扫描' },
    { id: 'raw', label: '原始事件' },
  ];

  return (
    <div className="fixed inset-y-10 right-0 z-40 flex w-[min(760px,calc(100vw-2rem))] flex-col border-l border-subtle bg-background shadow-xl">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-subtle px-4">
        <Activity className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">性能监视器</h2>
        {message && <span className="truncate text-xs text-muted-foreground">{message}</span>}
        <Button variant="ghost" size="icon" className="ml-auto" title="导出 JSON 到剪贴板" onClick={() => void exportJson()}>
          <Download />
        </Button>
        <Button variant="ghost" size="icon" title="清空" onClick={() => void clear()}>
          <Trash2 />
        </Button>
        <Button variant="ghost" size="icon" title="关闭（Esc）" onClick={closePerfPanel}>
          <X />
        </Button>
      </header>

      <div className="grid shrink-0 grid-cols-3 gap-2 border-b border-subtle p-3">
        <MetricCard
          label="最近 60 秒最大 long task"
          value={recentLongTask ? formatMs(recentLongTask.durationMs) : '—'}
          hint="renderer main thread > 50ms"
        />
        <MetricCard
          label="Renderer heap"
          value={heap == null ? '—' : formatBytes(heap)}
          hint="Chromium performance.memory"
        />
        <MetricCard
          label="事件数量"
          value={String(events.length)}
          hint={`main ${mainSnapshot?.events.length ?? 0} · renderer ${rendererSnapshot.events.length}`}
        />
      </div>

      <nav className="flex shrink-0 gap-1 border-b border-subtle px-3 py-2">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12px]',
              tab === item.id
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'slow' && <EventTable events={slowSpans} />}
        {tab === 'terminal' && <ReplayWaterfall groups={replayGroups} />}
        {tab === 'scan' && <EventTable events={scans} />}
        {tab === 'raw' && <EventTable events={events.slice(0, 100)} />}
      </main>
    </div>
  );
}
