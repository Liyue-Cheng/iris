/**
 * @file cpu/interrupts.ts
 * @purpose Inbound side of the causality loop (technical-design.md 中断系统):
 *   chokidar watches in main → IPC pushes batched events → renderer raises
 *   an interrupt → the projection ISR re-scans.
 *
 * External events never go through pipeline.dispatch — interrupts are the
 * designated entry. Dedup (M2: hash-compare against in-memory doc state to
 * swallow our own write echoes) is ISR business logic; in M1 the app never
 * writes, so every event is a genuine external change and a plain rescan is
 * correct.
 */
import { EVENTS } from '@shared/protocol';
import type { FsIrisChangedEvent } from '@shared/types';
import { pipeline } from './index';
import { projectStore } from '@renderer/stores/project-store';

export function wireInterrupts(): void {
  window.api.on<FsIrisChangedEvent>(EVENTS.FS_IRIS_CHANGED, (event) => {
    pipeline.interrupts.raise({
      type: 'fs.iris.changed',
      source: 'file-watcher',
      data: event,
    });
  });

  pipeline.interrupts.register({
    name: 'iris-projection',
    events: 'fs.iris.*',
    onInterrupt: (event) => {
      void projectStore.refreshFromFs(event.data as FsIrisChangedEvent);
    },
  });
}
