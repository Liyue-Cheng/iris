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
import type {
  FsIrisChangedEvent,
  SessionExitedPayload,
  SessionStateChangedPayload,
} from '@shared/types';
import { pipeline } from './index';
import { projectStore } from '@renderer/stores/project-store';
import { editorStore, readDocFromDisk } from '@renderer/stores/editor-store';
import { sessionStore } from '@renderer/stores/session-store';

export function wireInterrupts(): void {
  // Session lifecycle events → interrupts → projection ISR. (Output bytes
  // bypass this path entirely — they stream straight to the terminal view;
  // routing 60 batches/s through the interrupt controller buys nothing.)
  window.api.on<SessionStateChangedPayload>(EVENTS.SESSION_STATE_CHANGED, (event) => {
    pipeline.interrupts.raise({
      type: 'session.state-changed',
      source: 'session-manager',
      data: event,
    });
  });
  window.api.on<SessionExitedPayload>(EVENTS.SESSION_EXITED, (event) => {
    pipeline.interrupts.raise({ type: 'session.exited', source: 'session-manager', data: event });
  });
  window.api.on<{ sessionId: string }>(EVENTS.SESSION_DESTROYED, (event) => {
    pipeline.interrupts.raise({
      type: 'session.destroyed',
      source: 'session-manager',
      data: event,
    });
  });

  pipeline.interrupts.register({
    name: 'session-projection',
    events: 'session.*',
    onInterrupt: (event) => {
      if (event.type === 'session.state-changed') {
        const { sessionId, patch } = event.data as SessionStateChangedPayload;
        sessionStore.handlePatch(sessionId, patch);
      } else if (event.type === 'session.destroyed') {
        const { sessionId } = event.data as { sessionId: string };
        sessionStore.handleDestroyed(sessionId);
      }
      // session.exited needs no extra handling: the state-changed broadcast
      // carries state='exited' + exitCode in the same breath.
    },
  });
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
      const data = event.data as FsIrisChangedEvent;
      // Tree projection: rescans are cheap and idempotent — no dedup needed.
      void projectStore.refreshFromFs(data);
      // Editor projection: dedup + conflict policy live inside the store
      // (state compare against lastWritten — deterministic, no heuristics).
      const open = editorStore.get();
      if (!open) return;
      for (const c of data.changes) {
        if (c.path !== open.path) continue;
        if (c.kind === 'unlink') {
          editorStore.handleDiskUnlink(c.path);
        } else if (c.kind === 'change' || c.kind === 'add') {
          void editorStore.handleDiskChange(c.path, () => readDocFromDisk(c.path));
        }
      }
    },
  });
}
